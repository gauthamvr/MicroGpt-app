// modules/expo-download-manager/ios/ExpoDownloadManagerModule.swift
//
// iOS port of the Android OkHttp-based ExpoDownloadManager. Mirrors the
// same JS-facing contract (src/index.ts) and the same on-disk behaviour:
//
//   • Streams bytes straight into "${destPath}.part" via FileHandle.
//   • Resumes any existing ".part" via an HTTP `Range: bytes=N-` header.
//   • Emits onDownloadProgress (~2 Hz) with honest byte counts, an
//     EWMA-smoothed bytes/sec, and an ETA — identical field shapes to
//     the Kotlin module so the JS layer is platform-agnostic.
//   • Transient errors (timeouts / dropped sockets) retry up to 3× with
//     exponential backoff, resuming from the preserved ".part".
//   • Atomically promotes ".part" → final on a verified-size success.
//
// Differences from Android, by platform necessity:
//   • No system notification / cancel-from-tray action. iOS doesn't allow
//     a long-lived live-updating progress notification without a push or
//     a background session that conflicts with our streaming model. The
//     in-app progress UI already reflects everything; the Android tray
//     entry was a nicety, not a correctness dependency.
//   • Battery-optimization calls are no-ops (iOS has no equivalent).
//
// Like the Android version (which uses a plain OkHttp coroutine, not a
// foreground service), transfers run while the app process is alive. The
// preserved ".part" lets startDownload() resume after a kill.

import ExpoModulesCore
import Foundation

// DownloadManager-compatible status codes (android.app.DownloadManager),
// mirrored so JS switches on one enum across platforms.
private let STATUS_RUNNING = 2

private let CONNECT_TIMEOUT_SEC: TimeInterval = 30
// Per-request "waiting for more data" timeout. Doubles as the stuck
// detector: if no bytes arrive for this long, URLSession aborts the task
// and we fall into the transient-retry path. Matches Android's 60s read
// timeout + STUCK_THRESHOLD intent.
private let READ_TIMEOUT_SEC: TimeInterval = 60
private let IO_PROGRESS_EMIT_INTERVAL_MS: Double = 500
private let EWMA_ALPHA = 0.3
private let MAX_RETRIES = 3

/// Per-download mutable state. Reference type so the delegate and the
/// module share one instance.
private final class TrackedDownload {
  let downloadId: Int
  let url: String
  let destPath: String
  let modelName: String
  let title: String
  let startedAtMs: Double

  var bytesDownloaded: Int64 = 0
  var bytesTotal: Int64 = 0

  // EWMA speed state
  var lastEmitMs: Double = 0
  var lastEmitBytes: Int64 = 0
  var smoothedBps: Double = 0

  // Streaming file state
  var fileHandle: FileHandle?
  var startOffset: Int64 = 0

  var task: URLSessionDataTask?
  var attempt: Int = 0

  // True once the user explicitly paused/cancelled, so didComplete
  // doesn't treat the resulting NSURLErrorCancelled as a failure.
  var stopped: Bool = false
  // Whether a stop should also wipe the ".part" (cancel) or keep it (pause).
  var deletePartialOnStop: Bool = false

  init(downloadId: Int, url: String, destPath: String, modelName: String, title: String, startedAtMs: Double) {
    self.downloadId = downloadId
    self.url = url
    self.destPath = destPath
    self.modelName = modelName
    self.title = title
    self.startedAtMs = startedAtMs
  }
}

/// Owns the URLSession + tracking and implements the streaming delegate.
/// Kept separate from the Expo `Module` (which isn't an NSObject) because
/// URLSessionDelegate requires NSObjectProtocol conformance.
private final class Downloader: NSObject, URLSessionDataDelegate {
  /// Set by the module; forwards to `sendEvent`.
  var onEvent: ((String, [String: Any]) -> Void)?

  // Serializes all access to `tracked` / `taskToId` / `nextId`.
  private let lock = NSLock()
  private var tracked: [Int: TrackedDownload] = [:]
  private var taskToId: [Int: Int] = [:]   // URLSessionTask.taskIdentifier → downloadId
  private var nextId: Int = 1

  private lazy var session: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = READ_TIMEOUT_SEC
    cfg.timeoutIntervalForResource = .greatestFiniteMagnitude // multi-GB can take hours
    cfg.waitsForConnectivity = true
    cfg.allowsCellularAccess = true
    cfg.httpShouldUsePipelining = false
    // Background-session semantics would force download-tasks-only and a
    // temp-file handoff that breaks our Range/.part streaming. A default
    // (in-process) session matches Android's process-lifetime model.
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 4
    queue.name = "ExpoDownloadManager.delegate"
    return URLSession(configuration: cfg, delegate: self, delegateQueue: queue)
  }()

  // MARK: - Public API (called from the module)

  func start(url: String, destPath: String, modelName: String, title: String) -> Int {
    lock.lock()
    let id = nextId
    nextId += 1
    let t = TrackedDownload(
      downloadId: id, url: url, destPath: destPath,
      modelName: modelName, title: title,
      startedAtMs: Date().timeIntervalSince1970 * 1000
    )
    tracked[id] = t
    lock.unlock()
    beginRequest(t)
    return id
  }

  func cancel(_ downloadId: Int) {
    stop(downloadId, deletePartial: true)
  }

  func pause(_ downloadId: Int) {
    stop(downloadId, deletePartial: false)
  }

  func activeDownloads() -> [[String: Any]] {
    lock.lock(); defer { lock.unlock() }
    return tracked.values.map { t in
      [
        "downloadId": Double(t.downloadId),
        "modelName": t.modelName,
        "title": t.title,
        "destPath": t.destPath,
        "bytesDownloaded": Int(t.bytesDownloaded),
        "bytesTotal": Int(t.bytesTotal),
        "bytesPerSec": t.smoothedBps,
        "status": STATUS_RUNNING,
        "localUri": "file://\(t.destPath)",
      ]
    }
  }

  func destroy() {
    lock.lock()
    let all = Array(tracked.values)
    tracked.removeAll()
    taskToId.removeAll()
    lock.unlock()
    for t in all {
      t.stopped = true
      t.task?.cancel()
      closeHandle(t)
    }
    session.invalidateAndCancel()
  }

  // MARK: - Request lifecycle

  private func beginRequest(_ t: TrackedDownload) {
    let partPath = t.destPath + ".part"
    let finalPath = t.destPath

    // Final already present and non-trivial → emit complete, don't refetch.
    if let attrs = try? FileManager.default.attributesOfItem(atPath: finalPath),
       let size = (attrs[.size] as? NSNumber)?.int64Value, size > 1024 {
      t.bytesDownloaded = size
      t.bytesTotal = size
      emitComplete(t, totalBytes: size)
      untrack(t.downloadId)
      return
    }

    let resumeFrom: Int64 = {
      if let attrs = try? FileManager.default.attributesOfItem(atPath: partPath),
         let size = (attrs[.size] as? NSNumber)?.int64Value {
        return size
      }
      return 0
    }()

    guard let requestUrl = URL(string: t.url) else {
      emitError(t, reason: "Invalid URL")
      untrack(t.downloadId)
      return
    }

    var req = URLRequest(url: requestUrl)
    req.timeoutInterval = READ_TIMEOUT_SEC
    req.setValue("MicroGPT/1.0", forHTTPHeaderField: "User-Agent")
    // Disable gzip so streamed byte counts line up with the file size.
    req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if resumeFrom > 0 {
      req.setValue("bytes=\(resumeFrom)-", forHTTPHeaderField: "Range")
    }
    t.startOffset = resumeFrom

    let task = session.dataTask(with: req)
    t.task = task
    lock.lock()
    taskToId[task.taskIdentifier] = t.downloadId
    lock.unlock()
    task.resume()
  }

  private func stop(_ downloadId: Int, deletePartial: Bool) {
    lock.lock()
    let t = tracked[downloadId]
    lock.unlock()
    guard let t = t else { return }
    t.stopped = true
    t.deletePartialOnStop = deletePartial
    t.task?.cancel()
    closeHandle(t)
    if deletePartial {
      try? FileManager.default.removeItem(atPath: t.destPath + ".part")
    }
    untrack(downloadId)
  }

  // MARK: - URLSessionDataDelegate

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let t = trackedFor(dataTask) else { completionHandler(.cancel); return }
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }

    if !(200...299).contains(http.statusCode) {
      // Surface the HTTP failure through didCompleteWithError's path by
      // cancelling; mark a synthetic error so completion reports it.
      finishWithHTTPError(t, code: http.statusCode)
      completionHandler(.cancel)
      return
    }

    let isPartial = http.statusCode == 206
    let remaining = http.expectedContentLength // bytes left to download (or -1)

    let totalBytes: Int64
    if isPartial {
      // Prefer Content-Range's "/<total>" — expectedContentLength is only
      // the remaining slice on a 206.
      if let cr = http.value(forHTTPHeaderField: "Content-Range"),
         let slash = cr.lastIndex(of: "/"),
         let full = Int64(cr[cr.index(after: slash)...].trimmingCharacters(in: .whitespaces)) {
        totalBytes = full
      } else if remaining > 0 {
        totalBytes = t.startOffset + remaining
      } else {
        totalBytes = 0
      }
    } else {
      totalBytes = remaining > 0 ? remaining : 0
    }
    t.bytesTotal = totalBytes

    let partPath = t.destPath + ".part"
    // We asked for a range but the server replied 200 → it ignored Range;
    // restart from byte 0.
    var startOffset = t.startOffset
    if t.startOffset > 0 && !isPartial {
      try? FileManager.default.removeItem(atPath: partPath)
      startOffset = 0
    }

    // Ensure the destination directory exists.
    let dir = (partPath as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

    if !FileManager.default.fileExists(atPath: partPath) {
      FileManager.default.createFile(atPath: partPath, contents: nil)
    }
    guard let handle = FileHandle(forWritingAtPath: partPath) else {
      finishWithError(t, message: "Cannot open file for writing: \(partPath)")
      completionHandler(.cancel)
      return
    }
    if startOffset > 0 {
      handle.seek(toFileOffset: UInt64(startOffset))
    } else {
      handle.truncateFile(atOffset: 0)
    }
    t.fileHandle = handle
    t.startOffset = startOffset
    t.bytesDownloaded = startOffset
    t.lastEmitMs = 0
    t.lastEmitBytes = startOffset

    emitProgressThrottled(t, force: true)
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let t = trackedFor(dataTask), let handle = t.fileHandle else { return }
    if t.stopped { return }
    do {
      try handle.write(contentsOf: data)
    } catch {
      // Disk full or similar — abort; preserve the partial for a retry.
      t.task?.cancel()
      finishWithError(t, message: "Write failed: \(error.localizedDescription)")
      return
    }
    t.bytesDownloaded += Int64(data.count)
    emitProgressThrottled(t, force: false)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let t = trackedFor(task) else { return }
    closeHandle(t)

    // User-initiated pause/cancel: stop() already untracked + cleaned up.
    if t.stopped {
      return
    }

    if let error = error {
      let nsErr = error as NSError
      // A cancel we didn't initiate (rare) — treat as paused, keep .part.
      if nsErr.code == NSURLErrorCancelled {
        untrack(t.downloadId)
        return
      }
      handleTransientOrFail(t, message: error.localizedDescription)
      return
    }

    // Success path — verify size, then promote .part → final.
    let partPath = t.destPath + ".part"
    let finalPath = t.destPath
    let finalSize: Int64 = {
      if let attrs = try? FileManager.default.attributesOfItem(atPath: partPath),
         let s = (attrs[.size] as? NSNumber)?.int64Value { return s }
      return 0
    }()

    if t.bytesTotal > 0 && finalSize < t.bytesTotal {
      handleTransientOrFail(
        t,
        message: "Download truncated: expected \(formatBytes(t.bytesTotal)), got \(formatBytes(finalSize)). Will resume on retry."
      )
      return
    }

    do {
      if FileManager.default.fileExists(atPath: finalPath) {
        try? FileManager.default.removeItem(atPath: finalPath)
      }
      try FileManager.default.moveItem(atPath: partPath, toPath: finalPath)
    } catch {
      // Cross-volume or locked — fall back to copy + delete.
      do {
        try FileManager.default.copyItem(atPath: partPath, toPath: finalPath)
        try? FileManager.default.removeItem(atPath: partPath)
      } catch {
        finishWithError(t, message: "Finalize failed: \(error.localizedDescription)")
        return
      }
    }

    let actual: Int64 = {
      if let attrs = try? FileManager.default.attributesOfItem(atPath: finalPath),
         let s = (attrs[.size] as? NSNumber)?.int64Value { return s }
      return 0
    }()
    if t.bytesTotal > 0 && actual < t.bytesTotal {
      try? FileManager.default.removeItem(atPath: finalPath)
      finishWithError(t, message: "Post-move size mismatch: expected \(formatBytes(t.bytesTotal)), got \(formatBytes(actual))")
      return
    }

    t.bytesDownloaded = finalSize
    emitProgressThrottled(t, force: true)
    emitComplete(t, totalBytes: finalSize)
    untrack(t.downloadId)
  }

  // MARK: - Retry

  private func handleTransientOrFail(_ t: TrackedDownload, message: String) {
    let lower = message.lowercased()
    let isTransient = lower.contains("timeout") || lower.contains("timed out")
      || lower.contains("reset") || lower.contains("truncated")
      || lower.contains("closed") || lower.contains("network connection was lost")
      || lower.contains("eof") || lower.contains("offline")
      || lower.contains("connection")

    if isTransient && t.attempt < MAX_RETRIES && !t.stopped {
      t.attempt += 1
      let delayMs = min(2000.0 * pow(2.0, Double(t.attempt - 1)), 30_000.0)
      let deadline = DispatchTime.now() + .milliseconds(Int(delayMs))
      DispatchQueue.global(qos: .utility).asyncAfter(deadline: deadline) { [weak self] in
        guard let self = self else { return }
        // Re-check it wasn't cancelled during the backoff.
        self.lock.lock()
        let stillTracked = self.tracked[t.downloadId] != nil
        self.lock.unlock()
        if stillTracked && !t.stopped {
          self.beginRequest(t) // resumes from the preserved .part via Range
        }
      }
    } else {
      // Do NOT delete the partial — a manual retry resumes via Range.
      emitError(t, reason: message)
      untrack(t.downloadId)
    }
  }

  private func finishWithHTTPError(_ t: TrackedDownload, code: Int) {
    // HTTP-level failures aren't resumable the same way; report them.
    emitError(t, reason: "HTTP \(code)")
    untrack(t.downloadId)
  }

  private func finishWithError(_ t: TrackedDownload, message: String) {
    emitError(t, reason: message)
    untrack(t.downloadId)
  }

  // MARK: - Events

  private func emitProgressThrottled(_ t: TrackedDownload, force: Bool) {
    let now = Date().timeIntervalSince1970 * 1000
    if !force && now - t.lastEmitMs < IO_PROGRESS_EMIT_INTERVAL_MS {
      return
    }
    let dt = (now - t.lastEmitMs) / 1000.0
    let dBytes = max(t.bytesDownloaded - t.lastEmitBytes, 0)
    if dt > 0 && t.lastEmitMs != 0 {
      let instant = Double(dBytes) / dt
      t.smoothedBps = t.smoothedBps == 0 ? instant : EWMA_ALPHA * instant + (1 - EWMA_ALPHA) * t.smoothedBps
    }
    t.lastEmitMs = now
    t.lastEmitBytes = t.bytesDownloaded

    // Use NSNull (not a nil-wrapped Optional) so JS receives `null`.
    var eta: Any = NSNull()
    if t.bytesTotal > 0 && t.smoothedBps > 50 * 1024 {
      let remaining = max(t.bytesTotal - t.bytesDownloaded, 0)
      let rawEta = Double(remaining) / t.smoothedBps
      if rawEta >= 0 && rawEta <= Double(24 * 3600) {
        eta = Int(rawEta)
      }
    }

    // Byte counts emitted as Int (64-bit on iOS, so multi-GB is fine) —
    // the safest Expo-convertible numeric type for the JS bridge.
    onEvent?("onDownloadProgress", [
      "downloadId": Double(t.downloadId),
      "modelName": t.modelName,
      "bytesDownloaded": Int(t.bytesDownloaded),
      "bytesTotal": Int(t.bytesTotal),
      "bytesPerSec": t.smoothedBps,
      "etaSeconds": eta,
      "status": STATUS_RUNNING,
    ])
  }

  private func emitComplete(_ t: TrackedDownload, totalBytes: Int64) {
    onEvent?("onDownloadComplete", [
      "downloadId": Double(t.downloadId),
      "modelName": t.modelName,
      "destPath": t.destPath,
      "bytesTotal": Int(totalBytes),
    ])
  }

  private func emitError(_ t: TrackedDownload, reason: String) {
    onEvent?("onDownloadError", [
      "downloadId": Double(t.downloadId),
      "modelName": t.modelName,
      "reason": reason,
    ])
  }

  // MARK: - Helpers

  private func trackedFor(_ task: URLSessionTask) -> TrackedDownload? {
    lock.lock(); defer { lock.unlock() }
    guard let id = taskToId[task.taskIdentifier] else { return nil }
    return tracked[id]
  }

  private func untrack(_ downloadId: Int) {
    lock.lock()
    if let t = tracked.removeValue(forKey: downloadId), let task = t.task {
      taskToId.removeValue(forKey: task.taskIdentifier)
    }
    lock.unlock()
  }

  private func closeHandle(_ t: TrackedDownload) {
    if let h = t.fileHandle {
      try? h.close()
      t.fileHandle = nil
    }
  }

  private func formatBytes(_ bytes: Int64) -> String {
    let b = Double(bytes)
    if bytes >= 1024 * 1024 * 1024 { return String(format: "%.1f GB", b / 1024 / 1024 / 1024) }
    if bytes >= 1024 * 1024 { return String(format: "%.0f MB", b / 1024 / 1024) }
    if bytes >= 1024 { return String(format: "%.0f KB", b / 1024) }
    return "\(bytes) B"
  }
}

public class ExpoDownloadManagerModule: Module {
  private let downloader = Downloader()

  public func definition() -> ModuleDefinition {
    Name("ExpoDownloadManager")

    Events("onDownloadProgress", "onDownloadComplete", "onDownloadError")

    OnCreate {
      self.downloader.onEvent = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    // Sanity probe — JS verifies the module linked.
    Function("hello") { "world" }

    AsyncFunction("startDownload") { (url: String, destPath: String, modelName: String, title: String) -> Double in
      Double(self.downloader.start(url: url, destPath: destPath, modelName: modelName, title: title))
    }

    AsyncFunction("cancelDownload") { (downloadId: Double) in
      self.downloader.cancel(Int(downloadId))
    }

    AsyncFunction("pauseDownload") { (downloadId: Double) in
      self.downloader.pause(Int(downloadId))
    }

    AsyncFunction("getActiveDownloads") { () -> [[String: Any]] in
      self.downloader.activeDownloads()
    }

    AsyncFunction("getAvailableDiskSpace") { (path: String) -> Double in
      let dir: String = {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
          return path
        }
        return (path as NSString).deletingLastPathComponent
      }()
      // Prefer the "important usage" capacity (accounts for purgeable
      // space the OS can reclaim) and fall back to the raw free size.
      let url = URL(fileURLWithPath: dir)
      if let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
         let cap = values.volumeAvailableCapacityForImportantUsage {
        return Double(cap)
      }
      if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: dir),
         let free = (attrs[.systemFreeSize] as? NSNumber)?.doubleValue {
        return free
      }
      return -1
    }

    // iOS has no per-app battery-optimization toggle. Report "ignored"
    // (fail-open, never blocks a download) and make the request a no-op.
    Function("isBatteryOptimizationIgnored") { true }
    Function("requestBatteryOptimizationExemption") { true }

    OnDestroy {
      self.downloader.destroy()
    }
  }
}
