// modules/expo-download-manager/src/index.ts
//
// TypeScript wrapper over the ExpoDownloadManager native module — a
// pure-OkHttp downloader living inside the app process. There is no
// foreground service and no system DownloadManager involvement; see
// modules/expo-download-manager/android/.../ExpoDownloadManagerModule.kt
// for the Kotlin side.

import { requireNativeModule, EventEmitter } from 'expo-modules-core';

const ExpoDownloadManager = requireNativeModule('ExpoDownloadManager');

// ============================================================
// Types
// ============================================================

export type DownloadStartParams = {
  /** HTTPS URL to fetch */
  url: string;
  /** Absolute filesystem path to write to */
  destPath: string;
  /** Logical identifier JS uses to key its store */
  modelName: string;
  /** Title shown in the Android system notification */
  title?: string;
};

export type DownloadProgressEvent = {
  /** Synthetic download id assigned by the native module */
  downloadId: number;
  modelName: string;
  bytesDownloaded: number;
  /** 0 while total size is unknown (pre-HEAD) */
  bytesTotal: number;
  /** EWMA-smoothed download speed in bytes/sec */
  bytesPerSec: number;
  /** null while the speed sample isn't reliable yet */
  etaSeconds: number | null;
  /** DownloadManager.STATUS_* — RUNNING, PENDING, PAUSED, SUCCESSFUL, FAILED */
  status: number;
};

export type DownloadCompleteEvent = {
  downloadId: number;
  modelName: string;
  destPath: string;
  bytesTotal: number;
};

export type DownloadErrorEvent = {
  downloadId: number;
  modelName: string;
  reason: string;
};

export type ActiveDownload = {
  downloadId: number;
  /** Logical model identifier JS uses to key its store */
  modelName: string;
  /** Human-readable title (usually "ModelName.gguf") */
  title: string;
  /** Absolute filesystem path the download writes to */
  destPath: string;
  bytesDownloaded: number;
  bytesTotal: number;
  /** Smoothed transfer rate in bytes/sec (0 early in the download) */
  bytesPerSec: number;
  status: number;
  localUri: string | null;
};

// DownloadManager status constants from android.app.DownloadManager, mirrored
// here so JS code doesn't need to know the Android SDK values by heart.
export const DownloadStatus = {
  PENDING: 1,
  RUNNING: 2,
  PAUSED: 4,
  SUCCESSFUL: 8,
  FAILED: 16,
} as const;

// ============================================================
// API
// ============================================================

/**
 * Stage 1 sanity check — returns "world" from the Kotlin side if the
 * module is linked correctly. Useful at app startup to fail-fast if
 * Expo autolinking missed the local module.
 */
export function hello(): string {
  return ExpoDownloadManager.hello();
}

/**
 * Start a new download. Returns a synthetic download id — store it
 * alongside the modelName so you can correlate progress events and
 * call cancelDownload() later.
 *
 * The transfer runs entirely in OkHttp inside a coroutine on the app
 * process. There is NO foreground service and NO system notification:
 * if the OS kills the app process the download dies, but the .part
 * file is preserved so a future startDownload() resumes via HTTP Range.
 * Progress events arrive ~2x per second via onDownloadProgress.
 */
export async function startDownload(
  params: DownloadStartParams,
): Promise<number> {
  const id = await ExpoDownloadManager.startDownload(
    params.url,
    params.destPath,
    params.modelName,
    params.title ?? params.modelName,
  );
  return id;
}

/**
 * Cancel a download by id. Cancels the underlying OkHttp coroutine,
 * deletes the .part file, and untracks it from the native module. Any
 * in-flight progress events for this id stop immediately.
 */
export async function cancelDownload(downloadId: number): Promise<void> {
  await ExpoDownloadManager.cancelDownload(downloadId);
}

/**
 * Pause a download by id. Cancels the underlying OkHttp coroutine but
 * PRESERVES the `.part` file on disk, so a subsequent `startDownload`
 * with the same destination resumes via HTTP Range from where it left
 * off. JS is responsible for surfacing the partial in its own UI.
 */
export async function pauseDownload(downloadId: number): Promise<void> {
  await ExpoDownloadManager.pauseDownload(downloadId);
}

/**
 * Query the native module for downloads that are currently in flight.
 * Used on app cold-start to reconcile UI state when the app was
 * backgrounded but not killed: the native module's in-memory tracker
 * is the source of truth.
 *
 * Note: because there is no foreground service, downloads do NOT
 * survive a full process kill. This function returns an empty list
 * after a cold start — partial downloads on disk (`.part` files) are
 * resumed by calling startDownload() again, not by reconciling here.
 */
export async function getActiveDownloads(): Promise<ActiveDownload[]> {
  return ExpoDownloadManager.getActiveDownloads();
}

/**
 * Returns bytes available on the filesystem containing `path`.
 * Returns -1 if the check fails (e.g. path doesn't exist yet).
 */
export async function getAvailableDiskSpace(path: string): Promise<number> {
  return ExpoDownloadManager.getAvailableDiskSpace(path);
}

/**
 * Returns true if the app is excluded from battery optimization
 * (unrestricted background). On API < 23 always returns true.
 */
export function isBatteryOptimizationIgnored(): boolean {
  return ExpoDownloadManager.isBatteryOptimizationIgnored();
}

/**
 * Opens the system dialog to exclude this app from battery
 * optimization. Does nothing on API < 23 or unsupported OEM ROMs.
 */
export function requestBatteryOptimizationExemption(): void {
  ExpoDownloadManager.requestBatteryOptimizationExemption();
}

// ============================================================
// Event listeners
// ============================================================

/**
 * EventEmitter typed against the three events the Kotlin module emits.
 * Declared as a record type so the EventEmitter generic is happy and
 * each listener call-site gets the right payload shape.
 */
type DownloadEvents = {
  onDownloadProgress: (event: DownloadProgressEvent) => void;
  onDownloadComplete: (event: DownloadCompleteEvent) => void;
  onDownloadError: (event: DownloadErrorEvent) => void;
};

const emitter = new EventEmitter<DownloadEvents>(ExpoDownloadManager);

export function addProgressListener(
  callback: (event: DownloadProgressEvent) => void,
) {
  return emitter.addListener('onDownloadProgress', callback);
}

export function addCompleteListener(
  callback: (event: DownloadCompleteEvent) => void,
) {
  return emitter.addListener('onDownloadComplete', callback);
}

export function addErrorListener(
  callback: (event: DownloadErrorEvent) => void,
) {
  return emitter.addListener('onDownloadError', callback);
}
