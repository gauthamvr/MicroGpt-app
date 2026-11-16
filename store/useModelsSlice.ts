// store/useModelsSlice.ts
import { Platform } from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
// No longer using expo-file-system -- all file ops via react-native-blob-util
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { detectGgufModelType } from '@/lib/gguf-detect';
import { getModelsDir, getLegacyModelsDir } from '@/lib/storage-paths';
import { IOS_COREML_MODELS, downloadCoreMLModel } from '@/lib/coreml-models';
import { refreshBuiltInModels } from '@/lib/catalog-merge';

// ────────────────────────────────────────────────────────────────
//  Native download module availability probe
//
//  Our local expo-download-manager (modules/expo-download-manager/)
//  is a pure-OkHttp downloader that emits honest progress events
//  (bytes received + EWMA speed + ETA) from a coroutine inside the
//  app process. No foreground service: downloads only run while the
//  process is alive, but .part files are preserved across kills so
//  startDownload() resumes via HTTP Range.
//
//  Import is guarded by a try/catch `require` because if the native
//  module isn't linked (e.g. the user running this on iOS or a build
//  where autolinking missed the local module), the top-level
//  `requireNativeModule` call inside expo-download-manager throws
//  at import time. We catch it, set the module reference to null,
//  and fall through to the react-native-blob-util path.
// ────────────────────────────────────────────────────────────────
let ExpoDownloadManager: typeof import('expo-download-manager') | null = null;
try {
  // Native downloader: Android uses the OkHttp module. iOS has a URLSession
  // port too, but it's temporarily DISABLED while we debug an iOS-only UI
  // freeze that happens the moment a download starts — on iOS we fall back
  // to the react-native-blob-util fetch path below, which is the original
  // author's intended iOS download path. Re-enable by allowing 'ios' here
  // once the native module is verified on-device.
  if (Platform.OS === 'android') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ExpoDownloadManager = require('expo-download-manager');
  }
} catch {
  ExpoDownloadManager = null;
}

const NATIVE_DM_AVAILABLE: boolean = (() => {
  if (Platform.OS !== 'android') return false;
  if (!ExpoDownloadManager) return false;
  try {
    const probe = ExpoDownloadManager.hello?.();
    return probe === 'world';
  } catch {
    return false;
  }
})();

if (__DEV__) {
  // One-time log so we know which path is active during dev builds.
  // eslint-disable-next-line no-console
  console.log(
    `[useModelsSlice] native download module: ${NATIVE_DM_AVAILABLE ? 'ACTIVE' : 'not available, using fs.stat polling fallback'}`,
  );
}

/**
 * NPU (QNN) model URLs in the catalog are pinned to the `_qnn2.28_min`
 * variant for maximum compatibility — that file runs on every
 * QNN-capable Snapdragon chip. On newer SoCs (8 Gen 2 / 8 Gen 3 /
 * 8 Gen 4 / 8 Elite Gen 5) the `_qnn2.28_8gen2` variant uses the larger
 * Hexagon kernels and produces noticeably higher-quality output at the
 * same or better speed. Similarly, 8 Gen 1 / 8+ Gen 1 (SM8450/SM8475)
 * get their own `_qnn2.28_8gen1` build.
 *
 * We keep the catalog pinned to `_min` so it always shows a working URL
 * even if QNN detection fails, and rewrite to the chip-appropriate
 * variant here, right before handing the URL to DownloadManager.
 * Catalog size strings stay approximate — the variants differ by ~5%.
 */
const QNN_URL_MIN_RE = /_qnn2\.28_min\.zip(\?|$)/;

function detectQnnVariantSync(): 'min' | '8gen1' | '8gen2' | null {
  if (Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SD = require('expo-stable-diffusion');
    const diag: string = SD?.hello?.() ?? '';
    const m = diag.match(/qnn=(\S+)/);
    if (!m) return null;
    const v = m[1];
    if (v === 'min' || v === '8gen1' || v === '8gen2') return v;
    return null; // 'unsupported' or anything else
  } catch {
    return null;
  }
}

function resolveQnnDownloadUrl(url: string): string {
  if (!QNN_URL_MIN_RE.test(url)) return url;
  const variant = detectQnnVariantSync();
  if (!variant || variant === 'min') return url;
  return url.replace('_qnn2.28_min.zip', `_qnn2.28_${variant}.zip`);
}

/**
 * Tracks the mapping between native downloadId and the logical modelName
 * we use as a key in downloadProgress / downloadStats. The native module
 * emits events keyed by both, but we need the downloadId -> modelName
 * lookup for the completion and error events when we only get the id
 * from the system DownloadManager's broadcast receiver.
 *
 * Also tracks the destination path so the completion handler can verify
 * the final file exists at the expected location. Populated by
 * downloadModel() and cleared on complete / error / cancel.
 */
type NativeTrack = {
  modelName: string;
  destPath: string;
  /** Set when this download represents a model's main weights (not mmproj) */
  isMainModel: boolean;
  /** Optional mmproj URL to fetch AFTER the main model finishes */
  mmProjUrl?: string;
  mmProjSize?: string;
  /** Resolvers for the Promise the caller is awaiting */
  resolve?: () => void;
  reject?: (err: any) => void;
};
const nativeTrackingByDownloadId = new Map<number, NativeTrack>();

// Whether the native event listeners have been installed this process.
// Flipped to true on the first call to installNativeDownloadListeners()
// and never reset (listeners live for the whole process lifetime).
let nativeListenersRegistered = false;

// Guard so the reconcile-path complete hook is only installed once per
// app lifetime. Installed lazily from reconcileActiveDownloads() the
// first time there's something to reconnect to.
let reconcileCompleteHookInstalled = false;

/**
 * Register the native module's event listeners exactly once per process.
 * We keep a module-scoped flag so hot reload in dev doesn't pile up
 * duplicate subscriptions. Called lazily from downloadModel() the first
 * time a native download is enqueued.
 *
 * The event handlers take a zustand `set` callback so they can update
 * the store directly without capturing it via closure — the store
 * instance isn't available at module load time.
 */
function installNativeDownloadListeners(set: any, _get: any) {
  if (nativeListenersRegistered) return;
  if (!NATIVE_DM_AVAILABLE || !ExpoDownloadManager) return;
  nativeListenersRegistered = true;
  const dm = ExpoDownloadManager; // local capture narrows type from nullable

  dm.addProgressListener((e) => {
    const track = nativeTrackingByDownloadId.get(e.downloadId);
    if (!track) return;
    const name = track.modelName;
    const reportedTotal = e.bytesTotal > 0 ? e.bytesTotal : 0;
    // On the very first poll(s), Android DownloadManager may report
    // COLUMN_TOTAL_SIZE_BYTES = -1 because the HTTP Content-Length
    // header hasn't arrived yet. Fall back to the expected total we
    // already stored (parsed from the HuggingFace file-size string)
    // so the UI stays at 0% instead of flashing the indeterminate bar.
    //
    // For BOTH main model and mmproj downloads, the caller writes the
    // expected bytesTotal into downloadStats BEFORE enqueueing (the
    // main-model size is seeded in downloadModel(), the mmproj size is
    // seeded right before nativeEnqueue in the mmproj block). So we can
    // safely trust storeTotal as the fallback in either case.
    const storeTotal = _get().downloadStats?.[name]?.bytesTotal ?? 0;
    const total = reportedTotal > 0 ? reportedTotal : storeTotal;
    const fraction =
      total > 0 ? Math.min(0.999, e.bytesDownloaded / total) : -1;
    set((s: any) => ({
      downloadProgress: { ...s.downloadProgress, [name]: fraction },
      downloadStats: {
        ...s.downloadStats,
        [name]: {
          bytesReceived: e.bytesDownloaded,
          bytesTotal: total > 0 ? total : (s.downloadStats?.[name]?.bytesTotal ?? 0),
          bytesPerSec: e.bytesPerSec,
          etaSeconds: e.etaSeconds,
          startedAt: s.downloadStats?.[name]?.startedAt ?? Date.now(),
        },
      },
    }));
  });

  dm.addCompleteListener((e) => {
    const track = nativeTrackingByDownloadId.get(e.downloadId);
    if (!track) return;
    nativeTrackingByDownloadId.delete(e.downloadId);
    // Resolve the Promise the downloadModel caller is awaiting.
    // Downstream logic (file validation, mmproj download, store update)
    // happens in downloadModel() after the await resolves.
    track.resolve?.();
  });

  dm.addErrorListener((e) => {
    const track = nativeTrackingByDownloadId.get(e.downloadId);
    if (!track) return;
    nativeTrackingByDownloadId.delete(e.downloadId);
    track.reject?.(new Error(e.reason));
  });
}

/**
 * Enqueue a download via the native module and return a Promise that
 * resolves when the native side reports success, or rejects on error.
 * The caller is downloadModel() which awaits the returned promise and
 * then proceeds with file validation + mmproj handling + store update.
 */
async function nativeEnqueue(opts: {
  url: string;
  destPath: string;
  modelName: string;
  title: string;
  isMainModel: boolean;
  mmProjUrl?: string;
  mmProjSize?: string;
}): Promise<void> {
  if (!ExpoDownloadManager) {
    throw new Error('ExpoDownloadManager is not available');
  }
  const downloadId = await ExpoDownloadManager.startDownload({
    url: opts.url,
    destPath: opts.destPath,
    modelName: opts.modelName,
    title: opts.title,
  });

  return new Promise<void>((resolve, reject) => {
    nativeTrackingByDownloadId.set(downloadId, {
      modelName: opts.modelName,
      destPath: opts.destPath,
      isMainModel: opts.isMainModel,
      mmProjUrl: opts.mmProjUrl,
      mmProjSize: opts.mmProjSize,
      resolve,
      reject,
    });
  });
}

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
});

async function showDownloadCompleteNotification(modelName: string) {
  try {
    await Notifications.scheduleNotificationAsync({
      identifier: 'download-complete',
      content: {
        title: 'Download Complete',
        body: `${modelName} is ready to use`,
      },
      trigger: null,
    });
  } catch {}
}

export type ModelSource = 'builtIn' | 'huggingface' | 'local';

/**
 * Model category — controls which inference engine loads the file and which
 * UI surfaces. `text` = llama.rn text LLM, `vision` = llama.rn with mmproj
 * for image understanding, `imageGen` = stable diffusion for image generation.
 */
export type ModelType = 'text' | 'vision' | 'imageGen';

export type Model = {
  name: string;
  url: string;
  description: string;
  source: ModelSource;
  size?: string;
  mmProjUrl?: string;
  mmProjSize?: string;
  /** Defaults to 'text' (or 'vision' if mmProjUrl is set). Explicit for imageGen. */
  modelType?: ModelType;
  /**
   * iOS-only: HuggingFace repo of an Apple Core ML Stable Diffusion model
   * (e.g. "apple/coreml-stable-diffusion-2-1-base"). When set, the model is
   * downloaded as a directory of compiled .mlmodelc files via the Core ML
   * multi-file downloader (lib/coreml-models.ts) instead of a single file.
   */
  coremlRepo?: string;
};

/**
 * Resolve a model's type. If `modelType` is explicit, use it; otherwise
 * infer `vision` from mmProjUrl and default to `text`.
 */
export function getModelType(model: Model | null | undefined): ModelType {
  if (!model) return 'text';
  if (model.modelType) return model.modelType;
  if (model.mmProjUrl) return 'vision';
  return 'text';
}

export function isImageGenModel(model: Model | null | undefined): boolean {
  return getModelType(model) === 'imageGen';
}

/**
 * Heuristic detector for image generation model files downloaded from
 * HuggingFace. We can't introspect GGUF headers from JS without extra
 * native code, so we match against common Stable Diffusion filename
 * patterns. This catches the major SD families:
 *   - stable-diffusion-v1-5 / sd-v1-5 / stable-diffusion-1.5
 *   - stable-diffusion-2-1 / sd-v2-1
 *   - stable-diffusion-xl / sdxl / sd-xl
 *   - sd-turbo / sdxl-turbo / sd-2-1-turbo
 *   - flux (flux.1-dev, flux-schnell, flux.2)
 *   - sd3 / stable-diffusion-3
 *   - popular fine-tunes: dreamshaper, realistic-vision, anything-v,
 *     chilloutmix, meinamix, abolutereality, majicmix, mistoon, nai-anime
 *   - LCM variants
 *
 * False positives are possible (a text LLM literally named "flux-..."
 * would trip it) but in practice these name patterns don't appear in
 * mainstream text LLMs. Users can still override by editing the model
 * entry in the store if needed.
 */
const SD_FILENAME_RE =
  /(^|[-_.\s])(stable[\s\-._]?diffusion|sd[\s\-._]?v?(1\.?5|2\.?[01]|3|xl)|sdxl|sd[\s\-._]?turbo|flux[\s\-._]?(1|2|dev|schnell|klein)|dreamshaper|realistic[\s\-._]?vision|anything[\s\-._]?v\d|chillout[\s\-._]?mix|meina[\s\-._]?mix|absolute[\s\-._]?reality|majic[\s\-._]?mix|mistoon|nai[\s\-._]?anime|lcm[\s\-._]?dreamshaper|qwen[\s\-._]?image|z[\s\-._]?image)(?=[-_.\s]|$)/i;

export function detectImageGenFromFilename(name: string): boolean {
  if (!name) return false;
  return SD_FILENAME_RE.test(name);
}

/**
 * Per-download stats published from the file-size polling loop.
 *  - bytesReceived: how many bytes are on disk right now
 *  - bytesTotal:    expected size from Content-Length / known model size
 *                   (0 when truly unknown)
 *  - bytesPerSec:   smoothed download speed (EWMA)
 *  - etaSeconds:    estimated time-remaining (null when speed unknown)
 *  - startedAt:     epoch ms when polling began (used for ETA fallback)
 */
export type DownloadStats = {
  bytesReceived: number;
  bytesTotal: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  startedAt: number;
};

/**
 * Tracks the current phase of a download lifecycle. The UI uses this
 * to show phase-specific text instead of a raw percentage when the
 * download bytes are complete but post-processing is still running.
 */
export type DownloadPhase =
  | 'downloading'
  | 'verifying'
  | 'downloading_projector'
  | 'extracting'
  | 'finalizing';

/**
 * A `.part` file sitting on disk with no active downloader attached —
 * either paused by the user or left over from a previous app session
 * that was killed mid-download. Discovered by scanning the download
 * directory; resumable via HTTP Range as long as the server still
 * supports it (HF does).
 */
export type ResumableDownload = {
  /** Logical model name (filename minus extension) */
  modelName: string;
  /** Filename without the trailing `.part` (e.g. "Foo.gguf") */
  fileName: string;
  /** Bytes already on disk in the .part file */
  bytesOnDisk: number;
  /** mtime of the .part file in epoch ms — used to sort newest-first */
  lastModifiedMs: number;
  /** True when this partial is the vision projector (mmproj.gguf.part)
   *  and the main weights are already complete on disk. Resume runs
   *  only the mmproj phase. */
  mmprojOnly?: boolean;
  /** True when we have neither a catalog entry nor saved pendingDownloadMeta
   *  for this partial — usually a leftover from a pre-resume-feature
   *  install. UI hides Resume and shows Delete only. */
  orphan?: boolean;
};

/**
 * Persisted snapshot of everything we need to resume a download whose
 * URL is NOT in the catalog (HuggingFace browser, custom URL imports).
 * For catalog models, we look up the URL in `models[]` instead, so they
 * don't need an entry here. Cleared when the download succeeds or the
 * user explicitly deletes the partial.
 */
export type PendingDownloadMeta = {
  url: string;
  destPath: string;
  description?: string;
  source: ModelSource;
  size?: string;
  modelType?: ModelType;
  mmProjUrl?: string;
  mmProjSize?: string;
};

export interface ModelsSlice {
  models: Model[];
  downloadedModels: string[];
  selectedModel: Model | null;
  /** Dedicated slot for the active text/vision LLM (combo mode) */
  selectedTextModel: Model | null;
  /** Dedicated slot for the active image generation model (combo mode) */
  selectedImageGenModel: Model | null;
  /** When true, selecting a text model does NOT clear the image slot and vice versa */
  comboModeEnabled: boolean;
  /** Fraction in [0, 1] for each model name. -1 encodes indeterminate. */
  downloadProgress: Record<string, number>;
  /** Live byte/speed/ETA stats per model. Cleared when a download ends. */
  downloadStats: Record<string, DownloadStats>;
  /** Current phase per model name. Cleared when a download ends. */
  downloadPhase: Record<string, DownloadPhase>;
  /** True when ANY download is active. Derived from activeDownloads size. */
  isDownloading: boolean;
  hasAcceptedHuggingFaceTOS: boolean;
  /** True once the one-shot battery-optimization prompt has been shown
   *  to the user (regardless of whether they accepted). After this, the
   *  user manages it from the Downloads page. */
  batteryOptPromptShown: boolean;
  setBatteryOptPromptShown: (shown: boolean) => void;

  /**
   * Set of model names currently downloading. Replaces the old single
   * `currentDownloadModelName`. The UI can iterate this to show multiple
   * progress bars. `isDownloading` is derived as `activeDownloads.size > 0`.
   * `currentDownloadModelName` is kept as a convenience getter for any UI
   * that only cares about one name (returns the first, or null).
   */
  activeDownloads: Set<string>;
  currentDownloadModelName: string | null;
  /** Per-download blob-util fetch tasks keyed by model name */
  _activeDownloadTasks: Record<string, any>;
  /** Per-download polling timers keyed by model name */
  _activeDownloadPollers: Record<string, any>;
  pendingDownloads: string[];

  /** Partial downloads found on disk that aren't currently active.
   *  Refreshed from disk on app start and after pause/resume/delete. */
  resumableDownloads: ResumableDownload[];
  /** URL+meta needed to resume non-catalog downloads (HF browser, etc.).
   *  Persisted; cleared on success or explicit partial-delete. */
  pendingDownloadMeta: Record<string, PendingDownloadMeta>;

  totalDeviceMemory: number;

  lastUsedModelName: string | null;
  lastUsedImageGenModelName: string | null;
  setLastUsedModelName: (modelName: string | null) => void;

  acceptHuggingFaceTOS: () => void;
  initializeModels: () => Promise<void>;
  detectDeviceMemory: () => Promise<void>;
  rescanDownloadedModels: () => Promise<void>;
  /** Query the native module for downloads still running from before
   *  the app was closed, and re-seed the UI so they show up in the
   *  DownloadModel list with live progress again. */
  reconcileActiveDownloads: () => Promise<void>;
  downloadModel: (model: Model) => Promise<void>;
  cancelDownload: (modelName: string) => Promise<void>;
  /** Pause an active download — the .part file is preserved on disk
   *  and the model becomes resumable. */
  pauseDownload: (modelName: string) => Promise<void>;
  /** Resume a paused / abandoned partial download. Looks up the model
   *  in the catalog first, then in pendingDownloadMeta. */
  resumeDownload: (modelName: string) => Promise<void>;
  /** Delete a `.part` file and drop it from resumableDownloads. */
  deletePartialDownload: (modelName: string) => Promise<void>;
  /** Scan the download dir for `.part` files and rebuild resumableDownloads. */
  rescanResumableDownloads: () => Promise<void>;
  deleteModel: (modelName: string) => Promise<void>;
  selectModel: (model: Model | null) => void;
  selectTextModel: (model: Model | null) => void;
  selectImageGenModel: (model: Model | null) => void;
  setComboMode: (enabled: boolean) => void;

  didUserCloseDownloadModal?: boolean;
  setDidUserCloseDownloadModal?: (val: boolean) => void;

  /**
   * Copy a user-picked model file from the DocumentPicker result
   * into the Downloads folder and register it as a local model.
   *
   * @param hintedType User's declared intent from the picker UI
   *   ('text' / 'imageGen'). Overrides the filename/header heuristic
   *   when provided — safetensors/ckpt are always imageGen regardless.
   *   Leave undefined to fall back to auto-detect only.
   */
  addLocalModel: (
    fileUri: string,
    fileName: string,
    hintedType?: 'text' | 'imageGen',
  ) => Promise<void>;
}

/**
 * Convert a human-readable size string like "1.57 GB" to bytes.
 *
 * We use DECIMAL units (1 GB = 10^9 bytes) because:
 *   1. HuggingFace displays file sizes in decimal everywhere — so when
 *      a model lists "1.57 GB", the actual .gguf is ~1,570,000,000
 *      bytes, NOT 1,685,774,254 bytes (which would be binary).
 *   2. Disk storage advertising uses decimal, matching user intuition.
 *   3. Using binary here was causing a 7.4% overestimate of expected
 *      size, which tripped post-download validation with false
 *      positives ("got 1.5 GB, expected 1.6 GB") on files that were
 *      actually 100% complete.
 *
 * Device memory (from ActivityManager.MemoryInfo.totalMem) is reported
 * in binary bytes, so the ratio-vs-RAM warning in the UI will be
 * slightly pessimistic (model looks ~7% larger than RAM than it really
 * is). That's acceptable — it errs on the side of caution.
 */
export function parseFileSizeString(sizeString: string): number {
  const match = sizeString.match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'GB') return value * 1_000_000_000;
  if (unit === 'MB') return value * 1_000_000;
  if (unit === 'KB') return value * 1_000;
  return 0;
}

/** Format bytes into human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Format a duration in seconds into a short "12s" / "3m 14s" / "1h 22m" string */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

/**
 * Recursively search a directory (up to 3 levels) for MNN/QNN model
 * marker files (unet.mnn or unet.bin). Used by initializeModels and
 * rescanDownloadedModels to detect extracted model directories
 * regardless of nesting depth — QNN zips are double-nested.
 */
async function hasModelMarker(dir: string, depth: number): Promise<boolean> {
  if (depth > 3) return false;
  try {
    const files = await ReactNativeBlobUtil.fs.ls(dir);
    if (files.includes('unet.mnn') || files.includes('unet.bin')) return true;
    for (const f of files) {
      try {
        const sub = `${dir}/${f}`;
        if (await ReactNativeBlobUtil.fs.isDir(sub)) {
          if (await hasModelMarker(sub, depth + 1)) return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * Models are stored in the public Downloads folder so:
 * - DownloadManager can write directly
 * - Users can find/delete files in their file manager
 * - No cross-filesystem moves needed
 * We use a "MicroGPT" subfolder to keep things tidy.
 */
function getDownloadDir(): string {
  // Android → public Download/MicroGPT, iOS → Documents/MicroGPT.
  // See lib/storage-paths.ts. Android resolves exactly as before.
  return getModelsDir();
}

/**
 * Supported model file extensions. Text LLMs use .gguf; image gen
 * models use .safetensors or .gguf, and the MNN/QNN packs arrive as
 * .zip directories. We scan for all of these in initializeModels
 * and rescanDownloadedModels.
 */
const SUPPORTED_MODEL_EXTS = ['.gguf', '.safetensors', '.ckpt', '.zip'];

/**
 * Pick a headline text model to recommend for this device based on
 * probed "usable" memory (total RAM minus ~2 GB OS/app reservation,
 * clamped to ≥40 % of total — see detectDeviceMemory).
 *
 * Rule of thumb: the Q4_K_M weights should fit comfortably in
 * usable RAM with room for KV cache + inference scratch. We stay
 * conservatively below ~50 % of usable memory so long contexts and
 * the vision encoder (if the user later picks a vision variant)
 * still have room.
 *
 * Returns null when we haven't probed yet (totalDeviceMemory = 0),
 * so the UI can hide the banner rather than guess.
 */
export function getRecommendedModelName(usableMemoryBytes: number): string | null {
  if (!usableMemoryBytes || usableMemoryBytes <= 0) return null;
  const GB = 1024 * 1024 * 1024;
  const usableGB = usableMemoryBytes / GB;
  // Thresholds are in "usable" GB (not total device RAM):
  //  usable < 1.5  ≈ 4 GB phone       → tiny
  //  usable 1.5–3  ≈ 4–6 GB phone     → small
  //  usable 3–6    ≈ 6–10 GB phone    → mid
  //  usable ≥ 6    ≈ 10 GB+ flagship  → large
  if (usableGB < 1.5) return 'Qwen3.5-0.8B';
  if (usableGB < 3) return 'Qwen3.5-2B';
  if (usableGB < 6) return 'Qwen3.5-4B';
  return 'Qwen3.5-9B';
}

/**
 * Get the filename for a model as stored on disk. The extension is
 * derived from the model's download URL. Falls back to .gguf for
 * text LLMs (which is always correct) and for models with no URL.
 */
export function getModelFileName(model: { name: string; url?: string }): string {
  if (model.url) {
    // Strip query params then check the extension
    const cleanUrl = model.url.split('?')[0].toLowerCase();
    for (const ext of SUPPORTED_MODEL_EXTS) {
      if (cleanUrl.endsWith(ext)) return `${model.name}${ext}`;
    }
  }
  return `${model.name}.gguf`;
}

/** Check if a filename has any supported model extension */
function isSupportedModelFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return SUPPORTED_MODEL_EXTS.some((ext) => lower.endsWith(ext));
}

/** Check if a filename is a multimodal projector file (not a model) */
function isMMProjFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.includes('mmproj') ||
    lower.includes('projector') ||
    (lower.includes('clip') && lower.includes('vit'))
  );
}

/*
 * Catalog ordering matches the April 2026 ranking in
 * docs/model-catalog-2026-04.md: best-in-bucket first within each size
 * tier. The visual order shown in the suggested-models modal follows
 * this array, so entries should stay in this logical sequence even
 * after edits.
 */
const DEFAULT_BUILTIN_MODELS: Model[] = [
  /* ═══════ VISION MODELS (ranked) ═══════ */
  {
    // Ultra-tiny fallback for low-end devices — outclassed by Qwen3-VL-2B
    // at any ≥ 1 GB budget, kept only because nothing else fits under 200 MB.
    name: 'SmolVLM-256M-Vision',
    url: 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/SmolVLM-256M-Instruct-Q8_0.gguf',
    mmProjUrl: 'https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/resolve/main/mmproj-SmolVLM-256M-Instruct-f16.gguf',
    description: 'Smallest vision model. Understands images on any device',
    source: 'builtIn',
    size: '175 MB',
    mmProjSize: '190 MB',
  },
  {
    name: 'Qwen3-VL-2B-Vision',
    url: 'https://huggingface.co/unsloth/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3-VL-2B-Instruct-Q4_K_M.gguf',
    mmProjUrl: 'https://huggingface.co/unsloth/Qwen3-VL-2B-Instruct-GGUF/resolve/main/mmproj-F16.gguf',
    description: 'Qwen 3 vision-language. Strong image reasoning at tiny size',
    source: 'builtIn',
    size: '1.11 GB',
    mmProjSize: '819 MB',
  },
  {
    name: 'Qwen3-VL-4B-Vision',
    url: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/Qwen3-VL-4B-Instruct-Q4_K_M.gguf',
    mmProjUrl: 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main/mmproj-F16.gguf',
    description: 'Best mid-tier VLM of 2026. Sharp spatial reasoning & OCR',
    source: 'builtIn',
    size: '2.50 GB',
    mmProjSize: '836 MB',
  },
  {
    name: 'Gemma-4-E2B-Vision',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q3_K_M.gguf',
    mmProjUrl: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf',
    description: 'Google Gemma 4 vision. Image + audio understanding. 12GB+ RAM',
    source: 'builtIn',
    size: '2.54 GB',
    mmProjSize: '986 MB',
  },
  {
    name: 'Gemma-4-E4B-Vision',
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q3_K_M.gguf',
    mmProjUrl: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/mmproj-F16.gguf',
    description: 'Google Gemma 4 vision, best quality. Image + audio + video. 16GB+ RAM',
    source: 'builtIn',
    size: '4.06 GB',
    mmProjSize: '990 MB',
  },
  {
    // Flagship-only (12 GB+ RAM). GPT-4o-class image + video understanding.
    name: 'MiniCPM-V-4.5-Vision',
    url: 'https://huggingface.co/openbmb/MiniCPM-V-4_5-gguf/resolve/main/MiniCPM-V-4_5-Q4_K_M.gguf',
    mmProjUrl: 'https://huggingface.co/openbmb/MiniCPM-V-4_5-gguf/resolve/main/mmproj-model-f16.gguf',
    description: 'GPT-4o-class vision at 8B. Video understanding. 12GB+ RAM',
    source: 'builtIn',
    size: '5.03 GB',
    mmProjSize: '1.10 GB',
  },

  /* ═══════ TEXT: ULTRA-LIGHT (< 600MB) — 4GB RAM ═══════ */
  {
    // Has an mmproj sibling; catalog ships it as text-primary to keep the
    // download under 500 MB for phones that can't afford the projector.
    name: 'Qwen3.5-0.8B',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
    description: 'Latest Qwen 3.5, 201 languages. Best quality at tiny size',
    source: 'builtIn',
    size: '533 MB',
  },

  /* ═══════ TEXT: LIGHT (600MB - 1.5GB) — 6GB RAM ═══════ */
  {
    // Qwen3.5-2B is the sweet-spot pick for most Android phones.
    name: 'Qwen3.5-2B',
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf',
    description: 'Latest Qwen 3.5, best general model under 1.5 GB. 256K context',
    source: 'builtIn',
    size: '1.28 GB',
  },
  {
    name: 'Qwen3-1.7B',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    description: 'Qwen 3, 119 languages. Matches Qwen2.5-3B quality',
    source: 'builtIn',
    size: '1.11 GB',
  },
  {
    name: 'Gemma-3-1B',
    url: 'https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
    description: 'Google Gemma 3, strong multilingual and reasoning',
    source: 'builtIn',
    size: '806 MB',
  },

  /* ═══════ TEXT: MEDIUM (1.5 - 2.5GB) — 8GB RAM ═══════ */
  {
    name: 'Ministral-3-3B',
    url: 'https://huggingface.co/unsloth/Ministral-3-3B-Instruct-2512-GGUF/resolve/main/Ministral-3-3B-Instruct-2512-Q4_K_M.gguf',
    description: 'Mistral edge model. Best agent/tool-use under 3B',
    source: 'builtIn',
    size: '2.15 GB',
  },
  {
    name: 'Phi-4-mini',
    url: 'https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf',
    description: 'Microsoft Phi-4 mini, exceptional at STEM and coding',
    source: 'builtIn',
    size: '2.49 GB',
  },
  {
    // Visible chain-of-thought. Not recommended for roleplay — leaks
    // <think> tokens into the chat.
    name: 'DeepSeek-R1-Distill-Qwen-1.5B',
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q8_0.gguf',
    description: 'Reasoning model, shows thinking process step by step',
    source: 'builtIn',
    size: '1.89 GB',
  },
  {
    name: 'SmolLM3-3B',
    url: 'https://huggingface.co/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q4_K_M.gguf',
    description: 'HuggingFace SmolLM3. 128K context, dual-mode reasoning',
    source: 'builtIn',
    size: '1.92 GB',
  },

  /* ═══════ TEXT: LARGE (2.5 - 4GB) — 12GB+ RAM ═══════ */
  {
    // Best all-round phone text model of 2026.
    name: 'Qwen3.5-4B',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    description: 'Latest Qwen 3.5, best overall text model at 4B. 256K context',
    source: 'builtIn',
    size: '2.74 GB',
  },
  {
    name: 'Gemma-3-4B',
    url: 'https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf',
    description: 'Google Gemma 3 4B, excellent conversational quality',
    source: 'builtIn',
    size: '2.49 GB',
  },
  {
    // Gemma-3n has vision architecture but llama.cpp currently treats
    // it as text-only — intentionally no mmProjUrl here.
    name: 'Gemma-3n-E2B',
    url: 'https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf',
    description: 'Google Gemma 3n text-only. 2B memory, higher performance',
    source: 'builtIn',
    size: '3.03 GB',
  },

  /* ═══════ TEXT: FLAGSHIP (> 4 GB) — 12GB+ RAM ═══════ */
  {
    name: 'Ministral-3-8B',
    url: 'https://huggingface.co/unsloth/Ministral-3-8B-Instruct-2512-GGUF/resolve/main/Ministral-3-8B-Instruct-2512-Q4_K_M.gguf',
    description: 'Mistral 8B edge. Strong agentic & function-calling. 12GB+ RAM',
    source: 'builtIn',
    size: '5.20 GB',
  },
  {
    name: 'Qwen3.5-9B',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    description: 'Qwen 3.5 9B, desktop-class quality. 256K ctx. 16GB+ RAM',
    source: 'builtIn',
    size: '5.68 GB',
  },

  /* ═══════ IMAGE GENERATION — FAST (MNN format, GPU/NPU) ═══════
   *
   * MNN models run on the local-dream engine using Adreno GPU (OpenCL)
   * or Qualcomm NPU (QNN). Generation time: 5-30 seconds.
   * These are zip files containing clip.mnn, unet.mnn, etc.
   * After download, they're unzipped to a model directory.
   * ═══════════════════════════════════════════════════════════════ */
  {
    name: 'AbsoluteReality-MNN',
    url: 'https://huggingface.co/xororz/sd-mnn/resolve/main/AbsoluteReality.zip',
    description: 'Photorealistic. GPU accelerated, ~15-30s generation',
    source: 'builtIn',
    size: '1.19 GB',
    modelType: 'imageGen',
  },
  {
    name: 'AnythingV5-MNN',
    url: 'https://huggingface.co/xororz/sd-mnn/resolve/main/AnythingV5.zip',
    description: 'Anime/illustration. GPU accelerated, ~15-30s generation',
    source: 'builtIn',
    size: '1.19 GB',
    modelType: 'imageGen',
  },

  /* ═══════ IMAGE GENERATION — FASTEST (QNN format, Snapdragon NPU) ═══════
   *
   * QNN models run on the Qualcomm Hexagon NPU via the local-dream engine.
   * URLs here pin the `_min` variant — resolveQnnDownloadUrl() swaps in
   * `_8gen1` / `_8gen2` at download time based on the detected SoC so
   * flagships get the higher-quality kernels, and non-QNN devices never
   * see these rows (DownloadModel filters them via `npuSupported`).
   * ═══════════════════════════════════════════════════════════════════ */
  {
    name: 'DreamShaperV8-NPU',
    url: 'https://huggingface.co/xororz/sd-qnn/resolve/main/DreamShaperV8_qnn2.28_min.zip',
    description: 'Creative versatile. NPU accelerated, ~5-15s. Snapdragon only',
    source: 'builtIn',
    size: '1.15 GB',
    modelType: 'imageGen',
  },
  {
    name: 'AbsoluteReality-NPU',
    url: 'https://huggingface.co/xororz/sd-qnn/resolve/main/AbsoluteReality_qnn2.28_min.zip',
    description: 'Photorealistic. NPU accelerated, ~5-15s. Snapdragon only',
    source: 'builtIn',
    size: '993 MB',
    modelType: 'imageGen',
  },
  {
    name: 'AnythingV5-NPU',
    url: 'https://huggingface.co/xororz/sd-qnn/resolve/main/AnythingV5_qnn2.28_min.zip',
    description: 'Anime/illustration. NPU accelerated, ~5-15s. Snapdragon only',
    source: 'builtIn',
    size: '995 MB',
    modelType: 'imageGen',
  },

  /* ═══════ IMAGE GENERATION — UNIVERSAL (GGUF/safetensors, CPU) ═══════
   *
   * These run on the sd.cpp engine using CPU. Slower (~3 min at 256x256)
   * but support ANY model format: GGUF, safetensors, ckpt. Also support
   * newer architectures: SDXL, SD3, Flux — not just SD 1.5.
   * ═══════════════════════════════════════════════════════════════════ */
  {
    name: 'SD-1.5-Q8',
    url: 'https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf',
    description: 'SD 1.5 base, GGUF Q8. CPU, better quality than Q4',
    source: 'builtIn',
    size: '1.76 GB',
    modelType: 'imageGen',
  },
  {
    name: 'DreamShaper-8',
    url: 'https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors',
    description: 'Versatile creative style. CPU, safetensors',
    source: 'builtIn',
    size: '2.13 GB',
    modelType: 'imageGen',
  },
  {
    name: 'SD-1.5-Q4',
    url: 'https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf',
    description: 'SD 1.5 base, GGUF Q4. CPU, smallest download',
    source: 'builtIn',
    size: '1.57 GB',
    modelType: 'imageGen',
  },
  {
    name: 'MeinaPastel-SD1.5',
    url: 'https://huggingface.co/Meina/MeinaMix/resolve/main/MeinaPastel%20-%20baked%20VAE.safetensors',
    description: 'Anime/pastel style, baked VAE. CPU, safetensors',
    source: 'builtIn',
    size: '2.13 GB',
    modelType: 'imageGen',
  },
  {
    name: 'SDXL-Base-Q8',
    url: 'https://huggingface.co/kostakoff/stable-diffusion-xl-base-1.0-GGUF/resolve/main/sd_xl_base_1.0_0_Q8_0.gguf',
    description: 'SDXL base, native 1024px output, sharper detail than SD 1.5. CPU, GGUF Q8, slower',
    source: 'builtIn',
    size: '4.18 GB',
    modelType: 'imageGen',
  },
];

/**
 * Helper: remove a model from activeDownloads + clean up its tasks/pollers.
 * Derives isDownloading and currentDownloadModelName from the remaining set.
 */
function finishDownload(set: any, get: any, modelName: string) {
  set((s: any) => {
    const nextActive = new Set<string>(s.activeDownloads);
    nextActive.delete(modelName);
    const nextTasks = { ...s._activeDownloadTasks };
    delete nextTasks[modelName];
    const nextPollers = { ...s._activeDownloadPollers };
    if (nextPollers[modelName]) {
      try { clearInterval(nextPollers[modelName]); } catch {}
      delete nextPollers[modelName];
    }
    const nextStats = { ...s.downloadStats };
    delete nextStats[modelName];
    const nextProgress = { ...s.downloadProgress };
    delete nextProgress[modelName];
    const nextPhase = { ...s.downloadPhase };
    delete nextPhase[modelName];
    // Derive convenience fields from the remaining set
    const remaining = Array.from(nextActive);
    return {
      activeDownloads: nextActive,
      isDownloading: remaining.length > 0,
      currentDownloadModelName: remaining.length > 0 ? remaining[0] : null,
      _activeDownloadTasks: nextTasks,
      _activeDownloadPollers: nextPollers,
      downloadStats: nextStats,
      downloadProgress: nextProgress,
      downloadPhase: nextPhase,
      pendingDownloads: s.pendingDownloads.filter((m: string) => m !== modelName),
    };
  });
}

// The built-in catalog for this platform. iOS can't run the Android-format
// image-gen models (gguf / MNN / NPU) — its image engine is Core ML with a
// separate catalog — so hide them to avoid users downloading multi-GB files
// that won't load. Vision LLMs (multimodal text models) are NOT image-gen
// models and stay visible. Android gets the full catalog.
const BUILTIN_CATALOG: Model[] =
  Platform.OS === 'ios'
    ? [
        ...DEFAULT_BUILTIN_MODELS.filter((m) => !isImageGenModel(m)),
        ...IOS_COREML_MODELS,
      ]
    : DEFAULT_BUILTIN_MODELS;

const createModelsSlice = (set: any, get: any): ModelsSlice => ({
  models: [...BUILTIN_CATALOG],

  downloadedModels: [],
  selectedModel: null,
  selectedTextModel: null,
  selectedImageGenModel: null,
  comboModeEnabled: true,
  downloadProgress: {},
  downloadStats: {},
  downloadPhase: {},
  isDownloading: false,
  hasAcceptedHuggingFaceTOS: false,
  batteryOptPromptShown: false,
  setBatteryOptPromptShown: (shown) => {
    set({ batteryOptPromptShown: shown });
  },

  activeDownloads: new Set<string>(),
  currentDownloadModelName: null,
  _activeDownloadTasks: {},
  _activeDownloadPollers: {},
  pendingDownloads: [],
  resumableDownloads: [],
  pendingDownloadMeta: {},

  totalDeviceMemory: 0,

  lastUsedModelName: null,
  lastUsedImageGenModelName: null,
  setLastUsedModelName: (modelName) => {
    set({ lastUsedModelName: modelName });
  },

  didUserCloseDownloadModal: false,
  setDidUserCloseDownloadModal: (val) => {
    set({ didUserCloseDownloadModal: val });
  },

  acceptHuggingFaceTOS: () => {
    set({ hasAcceptedHuggingFaceTOS: true });
  },

  detectDeviceMemory: async () => {
    try {
      const mem = Device.totalMemory;
      if (typeof mem === 'number' && mem > 0) {
        const reservedBytes = 2 * 1024 * 1024 * 1024;
        const usableMemory = Math.max(mem - reservedBytes, mem * 0.4);
        set({ totalDeviceMemory: usableMemory });
      } else {
        set({ totalDeviceMemory: 0 });
      }
    } catch {
      set({ totalDeviceMemory: 0 });
    }
  },

  initializeModels: async () => {
    const downloadDir = getDownloadDir();
    try {
      await get().detectDeviceMemory();

      // POST_NOTIFICATIONS runtime grant (Android 13+). Without it the
      // download progress notification silently no-ops.
      if (Platform.OS === 'android') {
        try {
          await Notifications.requestPermissionsAsync();
        } catch {}
      }

      // Ensure MicroGPT download directory exists
      const dirExists = await ReactNativeBlobUtil.fs.isDir(downloadDir);
      if (!dirExists) {
        await ReactNativeBlobUtil.fs.mkdir(downloadDir);
      }

      // Surface any `.part` files left over from a previous session as
      // resumable downloads. The native module's HTTP Range logic picks
      // them up automatically when the user taps Resume.
      set({ pendingDownloads: [] });
      try { await get().rescanResumableDownloads(); } catch {}

      // Clean up orphaned _extract_temp_* directories from interrupted
      // ZIP extractions. If the app was killed mid-unzip, these accumulate
      // on disk taking up GB of space.
      try {
        const allFiles = await ReactNativeBlobUtil.fs.ls(downloadDir);
        for (const f of allFiles) {
          if (f.startsWith('_extract_temp_')) {
            try {
              await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${f}`);
              if (__DEV__) console.log(`[initializeModels] cleaned orphaned temp: ${f}`);
            } catch {}
          }
        }
      } catch {}

      // Scan both new public dir and old private dir for .gguf files
      // Skip mmproj/projector files — they are vision support files, not models.
      //
      // For each candidate .gguf, we cross-check against the known model
      // size (if the file matches a model in our catalog) and reject
      // anything smaller than 95% of expected. That catches files left
      // behind by the old DownloadManager code path where a partial
      // could be written to the final filename.
      const validated: string[] = [];
      const scanDirs = [
        downloadDir,
        `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/Downloads`,
      ];
      // The saved list comes from whichever app version wrote it; bring
      // its built-in entries up to this version's catalog first, so the
      // size check below compares against current sizes.
      const mergedModels = refreshBuiltInModels(get().models, BUILTIN_CATALOG);
      const catalogByName = new Map<string, Model>();
      for (const m of mergedModels) catalogByName.set(m.name, m);
      for (const dir of scanDirs) {
        try {
          const dirEx = await ReactNativeBlobUtil.fs.isDir(dir);
          if (!dirEx) continue;
          const files = await ReactNativeBlobUtil.fs.ls(dir);
          for (const f of files) {
            // Check for MNN/QNN model directories. Search recursively
            // because QNN zips extract with nested structure
            // (e.g., qnn_models_min/unet.bin inside the model dir).
            try {
              const subDir = `${dir}/${f}`;
              const isDir = await ReactNativeBlobUtil.fs.isDir(subDir);
              if (isDir && !validated.includes(f)) {
                if (await hasModelMarker(subDir, 0)) {
                  validated.push(f);
                  continue;
                }
              }
            } catch {}

            if (isSupportedModelFile(f) && !validated.includes(f) && !isMMProjFile(f)) {
              const stat = await ReactNativeBlobUtil.fs.stat(`${dir}/${f}`);
              const size = Number(stat?.size ?? 0);
              if (size <= 1024) continue;
              const baseName = f.replace(/\.(gguf|safetensors|ckpt)$/i, '');
              const known = catalogByName.get(baseName);
              const expected = known?.size
                ? parseFileSizeString(known.size)
                : 0;
              // Catalog sizes are rounded to 1 decimal place (e.g.
              // "1.57 GB"), so there's inherent ±1% slack just from
              // rounding. Anything under 80% is almost certainly a
              // genuinely broken file (partial write from the old
              // DownloadManager code path, or interrupted write under
              // a future bug). 80% catches those while letting
              // legitimate files through even with rounding + HTTP
              // header quirks.
              if (expected > 0 && size < expected * 0.8) {
                if (__DEV__) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[scanDownloads] rejecting ${f}: ${size} bytes < 80% of expected ${expected}`,
                  );
                }
                try { await ReactNativeBlobUtil.fs.unlink(`${dir}/${f}`); } catch {}
                continue;
              }
              validated.push(f);
            }
          }
        } catch {}
      }

      set({
        downloadedModels: validated,
        isDownloading: false,
        currentDownloadModelName: null,
        activeDownloads: new Set<string>(),
        downloadProgress: {},
        downloadStats: {},
        downloadPhase: {},
        _activeDownloadTasks: {},
        _activeDownloadPollers: {},
      });

      // Re-create model entries for downloaded files that aren't in the models array
      // (e.g. HuggingFace models lost during store migration/upgrade).
      // Re-run the image-gen filename detector so recovered files land in
      // the right UI bucket instead of defaulting to a text LLM.
      for (const fileName of validated) {
        const modelName = fileName.replace(/\.(gguf|safetensors|ckpt)$/i, '');
        if (!mergedModels.some((m) => m.name === modelName)) {
          const isImageGen = detectImageGenFromFilename(modelName);
          mergedModels.push({
            name: modelName,
            url: '',
            description: isImageGen
              ? 'Previously downloaded image generation model'
              : 'Previously downloaded model',
            source: 'huggingface',
            modelType: isImageGen ? 'imageGen' : undefined,
          });
        }
      }

      set({ models: mergedModels });

      // One-time migration: upgrade any downloaded-and-stored models that
      // don't yet have a modelType set by peeking at their GGUF header.
      // This catches files downloaded BEFORE header detection existed
      // (pre-v0.2 stores), plus fine-tuned / unknown-filename models that
      // the heuristic misclassified. Skips anything already tagged to
      // avoid re-reading headers on every boot. Runs async after the
      // initial set() so it doesn't block app startup — models get
      // Reconcile any download that's still running in the native
      // module from before the app was closed. This re-seeds the
      // store's activeDownloads / downloadProgress so the DownloadModel
      // UI shows the live progress bar instead of a fresh "download"
      // button. We await it so the UI is consistent the first time
      // it renders after app open. Errors are swallowed — reconciliation
      // is a best-effort UX polish, not a correctness-critical step.
      try {
        await get().reconcileActiveDownloads();
      } catch {}

      // reclassified and re-rendered as each probe completes.
      void (async () => {
        const downloadedSet = new Set(validated);
        const snapshot = get().models;
        for (const m of snapshot) {
          // Find the file in downloadedSet — could be any extension
          const matchedFile = [...downloadedSet].find(
            (f) => f.replace(/\.(gguf|safetensors|ckpt)$/i, '') === m.name,
          );
          if (!matchedFile) continue; // not on disk
          // Find the actual file — might be in either of the scan dirs
          let filePath: string | null = null;
          for (const dir of scanDirs) {
            const candidate = `${dir}/${matchedFile}`;
            try {
              if (await ReactNativeBlobUtil.fs.exists(candidate)) {
                filePath = candidate;
                break;
              }
            } catch {}
          }
          if (!filePath) continue;
          try {
            const probe = await detectGgufModelType(filePath);
            if (!probe.modelType) continue;

            // Two cases:
            //  (a) Unclassified entry — classify it. Trust both
            //      `gguf-arch` and the heuristic source. If detection
            //      lands on plain 'text' without vision evidence, leave
            //      it implicit (undefined → text in our checks).
            //  (b) Already-classified entry that disagrees with the
            //      file's actual GGUF header — only correct when the
            //      probe's source is the authoritative `gguf-arch`
            //      (i.e. the file's arch string was a known match).
            //      Avoids the heuristic source flip-flopping good
            //      classifications.
            const stored = m.modelType;
            const detected = probe.modelType;
            const authoritative = probe.source === 'gguf-arch';
            let next: typeof stored | undefined = stored;
            if (!stored) {
              // Case (a) — classify it (skip the implicit-text noop)
              if (detected === 'text' && !m.mmProjUrl) continue;
              next = detected;
            } else if (stored !== detected && authoritative) {
              // Case (b) — known mislabel; correct it.
              next = detected;
            } else {
              continue; // no change needed
            }

            set((s: any) => ({
              models: s.models.map((x: Model) =>
                x.name === m.name ? { ...x, modelType: next } : x,
              ),
            }));
            if (__DEV__) {
              // eslint-disable-next-line no-console
              console.log(
                `[initializeModels] ${stored ? 'corrected' : 'migrated'} "${m.name}" ${stored ?? '(none)'} -> ${next} (arch=${probe.architecture}, source=${probe.source})`,
              );
            }
          } catch {}
        }
      })();
    } catch (error) {
      if (__DEV__) console.error('Error initializing models:', error);
      themedAlert('Error', 'Failed to initialize models.');
    }
  },

  rescanDownloadedModels: async () => {
    try {
      const validated: string[] = [];

      // Scan both new public dir and old private dir
      const dirs = [
        getDownloadDir(),
        `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/Downloads`,
      ];

      // Build a lookup of known models so we can validate file size
      // against the expected size for catalog models. Files that are
      // < 80% of expected are treated as broken (likely a legacy partial
      // write from the old DownloadManager code path) and excluded —
      // matching the logic in initializeModels. 80% gives plenty of
      // slack for the 1-decimal rounding in catalog size strings.
      const catalogByName = new Map<string, Model>();
      for (const m of get().models) catalogByName.set(m.name, m);
      for (const m of DEFAULT_BUILTIN_MODELS) {
        if (!catalogByName.has(m.name)) catalogByName.set(m.name, m);
      }

      for (const dir of dirs) {
        try {
          const dirExists = await ReactNativeBlobUtil.fs.isDir(dir);
          if (!dirExists) continue;
          const files = await ReactNativeBlobUtil.fs.ls(dir);
          for (const f of files) {
            // Check for MNN/QNN model directories. Search recursively
            // because QNN zips extract with nested structure.
            try {
              const subDir = `${dir}/${f}`;
              const isDir = await ReactNativeBlobUtil.fs.isDir(subDir);
              if (isDir && !validated.includes(f)) {
                if (await hasModelMarker(subDir, 0)) {
                  validated.push(f);
                  continue;
                }
              }
            } catch {}

            if (isSupportedModelFile(f) && !validated.includes(f) && !isMMProjFile(f)) {
              const stat = await ReactNativeBlobUtil.fs.stat(`${dir}/${f}`);
              const size = Number(stat?.size ?? 0);
              if (size <= 1024) continue;
              const baseName = f.replace(/\.(gguf|safetensors|ckpt)$/i, '');
              const known = catalogByName.get(baseName);
              const expected = known?.size ? parseFileSizeString(known.size) : 0;
              if (expected > 0 && size < expected * 0.8) {
                if (__DEV__) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[rescanDownloads] rejecting ${f}: ${size} bytes < 80% of expected ${expected}`,
                  );
                }
                try { await ReactNativeBlobUtil.fs.unlink(`${dir}/${f}`); } catch {}
                continue;
              }
              validated.push(f);
            }
          }
        } catch {}
      }

      set({ downloadedModels: validated });
    } catch (err) {
      if (__DEV__) console.warn('Error rescanning downloads:', err);
    }
  },

  /**
   * Reconcile UI state with downloads still in flight in the native
   * module. Runs on app open: if the foreground service kept the
   * process alive while the user closed the activity, the native
   * module's tracked map still holds the active download(s) but the
   * JS-side activeDownloads set was wiped by Zustand rehydration.
   * This function re-seeds the store from native state and installs
   * the progress / complete / error listeners so new events flow back
   * to the (freshly re-rendered) DownloadModel UI.
   */
  reconcileActiveDownloads: async () => {
    if (!NATIVE_DM_AVAILABLE || !ExpoDownloadManager) {
      return;
    }
    let active: any[] = [];
    try {
      active = (await ExpoDownloadManager.getActiveDownloads()) as any[];
    } catch (err) {
      if (__DEV__) console.warn('[reconcile] getActiveDownloads failed:', err);
      return;
    }
    if (!active || active.length === 0) return;

    // Make sure we're listening for progress / complete / error events
    // before we touch the tracking map — otherwise the first event
    // after reconcile could slip through unobserved.
    installNativeDownloadListeners(set, get);

    const state = get();
    const nextActive = new Set<string>(state.activeDownloads);
    const nextProgress: Record<string, number> = { ...state.downloadProgress };
    const nextStats: Record<string, DownloadStats> = { ...state.downloadStats };
    let firstModelName: string | null = state.currentDownloadModelName;

    for (const d of active) {
      const modelName: string = d.modelName;
      const downloadId: number = Number(d.downloadId);
      const destPath: string = String(d.destPath ?? '');
      const bytesDownloaded: number = Number(d.bytesDownloaded ?? 0);
      const bytesTotal: number = Number(d.bytesTotal ?? 0);
      const bytesPerSec: number = Number(d.bytesPerSec ?? 0);
      if (!modelName) continue;

      // Skip models that are already downloaded — the native DownloadManager
      // can return stale entries after app restart or auth state changes.
      const baseName = modelName.replace(/-(MNN|NPU)$/, '');
      const alreadyDownloaded = state.downloadedModels.some(
        (f: string) => f === `${modelName}.gguf` || f === modelName || f === baseName
      );
      if (alreadyDownloaded) {
        if (__DEV__) console.log(`[reconcile] skipping ${modelName} — already in downloadedModels`);
        continue;
      }

      nextActive.add(modelName);
      const fraction = bytesTotal > 0
        ? Math.min(0.999, bytesDownloaded / bytesTotal)
        : -1;
      nextProgress[modelName] = fraction;
      nextStats[modelName] = {
        bytesReceived: bytesDownloaded,
        bytesTotal,
        bytesPerSec,
        etaSeconds: bytesPerSec > 50 * 1024 && bytesTotal > 0
          ? Math.max(0, Math.round((bytesTotal - bytesDownloaded) / bytesPerSec))
          : null,
        startedAt: Date.now(),
      };
      if (!firstModelName) firstModelName = modelName;

      // Re-register this download in the native tracking map so
      // progress / complete / error listeners resolve correctly. We
      // use a noop resolve/reject because there's no awaiting caller
      // (the original downloadModel invocation is long gone). Instead,
      // we attach a one-shot completion handler below that runs the
      // post-download file-validation + store update path directly.
      nativeTrackingByDownloadId.set(downloadId, {
        modelName,
        destPath,
        isMainModel: true,
        resolve: undefined,
        reject: undefined,
      });
    }

    // Build phase map — all reconciled downloads are mid-transfer
    const nextPhase: Record<string, DownloadPhase> = { ...get().downloadPhase };
    for (const d of active) {
      if (d.modelName) nextPhase[d.modelName] = 'downloading';
    }

    set({
      activeDownloads: nextActive,
      isDownloading: nextActive.size > 0,
      currentDownloadModelName: firstModelName,
      downloadProgress: nextProgress,
      downloadStats: nextStats,
      downloadPhase: nextPhase,
    });

    // When one of the reconciled downloads completes, run the normal
    // post-download finalizer so downloadedModels, modelType, and
    // selectedModel are all updated correctly — same code path as a
    // fresh download, just without the caller-side await.
    if (ExpoDownloadManager && !reconcileCompleteHookInstalled) {
      reconcileCompleteHookInstalled = true;
      ExpoDownloadManager.addCompleteListener(async (e) => {
        try {
          const modelName = e.modelName;
          const destPath = e.destPath;
          const s = get();
          // Only handle if this was a reconciled download (no active
          // downloadModel caller). We detect this by checking that
          // activeDownloads has the name BUT there's no tracking
          // resolver — a fresh downloadModel call would have its own
          // resolver registered.
          if (!s.activeDownloads.has(modelName)) return;

          // Validate the file like the normal downloadModel success path
          const stat = await ReactNativeBlobUtil.fs.stat(destPath);
          const size = Number(stat?.size ?? 0);
          if (size < 1024) return;

          // GGUF header classification
          let resolvedModelType: ModelType | undefined;
          try {
            const probe = await detectGgufModelType(destPath);
            if (probe.modelType) resolvedModelType = probe.modelType;
          } catch {}

          // Update the model in the catalog + mark downloaded
          set((st: any) => {
            const updatedModels = st.models.map((m: Model) =>
              m.name === modelName
                ? { ...m, modelType: resolvedModelType ?? m.modelType }
                : m,
            );
            // Check if any extension variant is already in the list
            const alreadyListed = st.downloadedModels.some(
              (f: string) => f.replace(/\.(gguf|safetensors|ckpt)$/i, '') === modelName,
            );
            const downloaded = alreadyListed
              ? st.downloadedModels
              : [...st.downloadedModels, destPath.split('/').pop() ?? `${modelName}.gguf`];
            return {
              models: updatedModels,
              downloadedModels: downloaded,
            };
          });
          // Clean up ALL download state — progress, phase, stats, etc.
          finishDownload(set, get, modelName);
          showDownloadCompleteNotification(modelName);
        } catch (err) {
          if (__DEV__) console.warn('[reconcile complete] error:', err);
        }
      });
    }
  },

  /**
   * Downloads a model using react-native-blob-util.
   * This uses Android's native download service which:
   * - Survives app minimize and backgrounding
   * - Shows progress in the notification shade
   * - Handles network interruptions
   */
  downloadModel: async (model) => {
    // Check if THIS specific model is already downloading
    const { activeDownloads } = get();
    if (activeDownloads.has(model.name)) {
      themedAlert(
        'Already Downloading',
        `"${model.name}" is already downloading.`,
      );
      return;
    }

    // ─── iOS Core ML image models: multi-file download path ───────────
    // Apple Core ML SD models are directories of compiled .mlmodelc bundles
    // fetched file-by-file from HuggingFace (lib/coreml-models.ts). This is
    // entirely separate from the GGUF/zip flow below and only ever runs on
    // iOS for catalog entries carrying `coremlRepo`.
    if (Platform.OS === 'ios' && model.coremlRepo) {
      const startedAt = Date.now();
      set((s: any) => ({
        activeDownloads: new Set([...s.activeDownloads, model.name]),
        isDownloading: true,
        currentDownloadModelName: model.name,
        downloadProgress: { ...s.downloadProgress, [model.name]: 0 },
        downloadPhase: { ...s.downloadPhase, [model.name]: 'downloading' },
        downloadStats: {
          ...s.downloadStats,
          [model.name]: {
            bytesReceived: 0,
            bytesTotal: parseFileSizeString(model.size || ''),
            bytesPerSec: 0,
            etaSeconds: null,
            startedAt,
          },
        },
      }));
      try {
        let lastBytes = 0;
        let lastTime = startedAt;
        let smoothedBps = 0;
        await downloadCoreMLModel(model, {
          isCancelled: () => !get().activeDownloads.has(model.name),
          onProgress: (p) => {
            const now = Date.now();
            const dt = (now - lastTime) / 1000;
            const dBytes = p.bytesDownloaded - lastBytes;
            if (dt > 0.4 && dBytes >= 0) {
              const inst = dBytes / dt;
              smoothedBps = smoothedBps === 0 ? inst : 0.3 * inst + 0.7 * smoothedBps;
              lastBytes = p.bytesDownloaded;
              lastTime = now;
            }
            let eta: number | null = null;
            if (p.bytesTotal > 0 && smoothedBps > 50 * 1024) {
              const r = (p.bytesTotal - p.bytesDownloaded) / smoothedBps;
              if (r > 0 && r < 24 * 3600) eta = Math.round(r);
            }
            set((s: any) => ({
              downloadProgress: { ...s.downloadProgress, [model.name]: p.fraction },
              downloadStats: {
                ...s.downloadStats,
                [model.name]: {
                  bytesReceived: p.bytesDownloaded,
                  bytesTotal: p.bytesTotal,
                  bytesPerSec: smoothedBps,
                  etaSeconds: eta,
                  startedAt,
                },
              },
            }));
          },
        });
        // Success — register the model directory just like the zip path.
        const st = get();
        const updated = st.models.filter((m: Model) => m.name !== model.name);
        updated.push({ ...model, modelType: 'imageGen' as ModelType });
        set((s: any) => ({
          models: updated,
          downloadedModels: s.downloadedModels.includes(model.name)
            ? s.downloadedModels
            : [...s.downloadedModels, model.name],
        }));
        get().selectModel({ ...model, modelType: 'imageGen' as ModelType });
        finishDownload(set, get, model.name);
        showDownloadCompleteNotification(model.name);
      } catch (err: any) {
        const cancelled = String(err?.message || '').toLowerCase().includes('cancel');
        finishDownload(set, get, model.name);
        if (!cancelled) {
          themedAlert(
            'Download Failed',
            `Couldn't download ${model.name}: ${err?.message ?? 'unknown error'}`,
          );
        }
      }
      return;
    }

    const downloadDir = getDownloadDir();
    // Ensure the destination dir exists. On iOS the react-native-blob-util
    // fetch path won't create missing parent directories, and the
    // Documents/MicroGPT folder doesn't exist until the first download.
    await ReactNativeBlobUtil.fs.mkdir(downloadDir).catch(() => {});
    const modelFile = getModelFileName(model);
    const partialPath = `${downloadDir}/${modelFile}.part`;
    const finalPath = `${downloadDir}/${modelFile}`;
    // For NPU zips, rewrite the catalog's `_min` URL to the variant that
    // matches the user's Snapdragon chip. See resolveQnnDownloadUrl above.
    const downloadUrl = resolveQnnDownloadUrl(model.url);

    // Check if already downloaded (full file or extracted directory).
    // mmprojOnly = true when the main weights are complete but the
    // vision projector is missing/partial — the function skips the main
    // download and goes straight to the mmproj phase.
    let mmProjOnly = false;
    try {
      const alreadyExists = await ReactNativeBlobUtil.fs.exists(finalPath);
      if (alreadyExists) {
        const stat = await ReactNativeBlobUtil.fs.stat(finalPath);
        if (stat && stat.size > 1024) {
          // Main weights are on disk. If the model has an mmproj sibling
          // and that file is missing (or smaller than 10 KB, our "is this
          // really a projector" sanity floor), resume just the projector
          // phase instead of bailing with "Already Downloaded".
          if (model.mmProjUrl) {
            const mmProjPath = `${downloadDir}/${model.name}.mmproj.gguf`;
            let mmComplete = false;
            try {
              const mmStat = await ReactNativeBlobUtil.fs.stat(mmProjPath);
              mmComplete = !!(mmStat && Number(mmStat.size) >= 10 * 1024);
            } catch {}
            if (mmComplete) {
              await get().rescanDownloadedModels();
              themedAlert('Already Downloaded', `${model.name} is already on device.`);
              get().selectModel(model);
              return;
            }
            mmProjOnly = true;
          } else {
            await get().rescanDownloadedModels();
            themedAlert('Already Downloaded', `${model.name} is already on device.`);
            get().selectModel(model);
            return;
          }
        }
      }
      // For ZIP models, also check if the extracted directory exists
      if (modelFile.endsWith('.zip') && !mmProjOnly) {
        const extractedDir = `${downloadDir}/${model.name}`;
        const dirExists = await ReactNativeBlobUtil.fs.isDir(extractedDir);
        if (dirExists) {
          await get().rescanDownloadedModels();
          themedAlert('Already Downloaded', `${model.name} is already on device.`);
          get().selectModel(model);
          return;
        }
      }
    } catch {}

    // ── Disk space pre-check ──
    // Abort early if the device doesn't have enough room. We need the
    // model size PLUS a safety margin for .part rename + zip extraction.
    if (Platform.OS === 'android' && NATIVE_DM_AVAILABLE && ExpoDownloadManager) {
      const expectedBytes = parseFileSizeString(model.size || '');
      if (expectedBytes > 0) {
        try {
          const available = await ExpoDownloadManager.getAvailableDiskSpace(downloadDir);
          // Need model size + 20% headroom (zip extraction doubles briefly)
          const needed = modelFile.endsWith('.zip') ? expectedBytes * 2.2 : expectedBytes * 1.2;
          if (available > 0 && available < needed) {
            const avail = formatBytes(available);
            const need = formatBytes(needed);
            themedAlert(
              'Not Enough Storage',
              `This model needs ~${need} of free space but only ${avail} is available. Free up space and try again.`,
            );
            return;
          }
        } catch {}
      }
    }

    // ── Battery optimization prompt (one-shot) ──
    // On Android, large downloads can be killed by aggressive doze if
    // the app isn't excluded from battery optimization. Prompt the user
    // exactly once across the app's lifetime; afterwards they manage it
    // from the Downloads page.
    if (Platform.OS === 'android' && NATIVE_DM_AVAILABLE && ExpoDownloadManager) {
      try {
        const promptShown = get().batteryOptPromptShown;
        const ignored = ExpoDownloadManager.isBatteryOptimizationIgnored();
        if (!promptShown && !ignored) {
          await new Promise<void>((resolve) => {
            themedAlert(
              'Keep Downloads Running',
              'To prevent Android from pausing large downloads when your screen is off, allow unrestricted battery usage for this app. You can change this later in Downloads.',
              [
                {
                  text: 'Not Now',
                  style: 'cancel',
                  onPress: () => {
                    set({ batteryOptPromptShown: true });
                    resolve();
                  },
                },
                {
                  text: 'Allow',
                  onPress: () => {
                    ExpoDownloadManager!.requestBatteryOptimizationExemption();
                    set({ batteryOptPromptShown: true });
                    resolve();
                  },
                },
              ],
            );
          });
        }
      } catch {}
    }

    // Note: we no longer bail out if a .part file exists — the native
    // OkHttp downloader automatically resumes from any partial via an
    // HTTP Range header, so a stuck/interrupted download picks up right
    // where it left off when the user retries. The activeDownloads set
    // check above still prevents double-starting the same download in
    // the same session.
    let resumeFromBytes = 0;
    try {
      const partialExists = await ReactNativeBlobUtil.fs.exists(partialPath);
      if (partialExists) {
        const stat = await ReactNativeBlobUtil.fs.stat(partialPath);
        if (stat && stat.size > 1024) {
          resumeFromBytes = Number(stat.size) || 0;
          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log(
              `[downloadModel] resuming ${model.name} from ${resumeFromBytes} bytes`,
            );
          }
        }
      }
    } catch {}

    // Clear any stale progress/stats for this model and register it as
    // an active download in a SINGLE atomic set() call. This prevents
    // the UI from briefly rendering old progress from a previous run.
    set((s: any) => {
      const nextProgress = { ...s.downloadProgress };
      delete nextProgress[model.name];
      const nextStats = { ...s.downloadStats };
      delete nextStats[model.name];
      const nextPhase = { ...s.downloadPhase };
      nextPhase[model.name] = 'downloading';
      const nextActive = new Set<string>(s.activeDownloads);
      nextActive.add(model.name);
      const nextResumable = s.resumableDownloads.filter(
        (r: ResumableDownload) => r.modelName !== model.name,
      );
      // Persist enough meta to resume this download in a future app
      // session if the process gets killed before completion. Catalog
      // models look up their URL from `models[]` instead, but storing
      // it here too is cheap and means resume works even if the catalog
      // list is mutated.
      const nextMeta = {
        ...s.pendingDownloadMeta,
        [model.name]: {
          url: downloadUrl,
          destPath: finalPath,
          description: model.description,
          source: model.source,
          size: model.size,
          modelType: model.modelType,
          mmProjUrl: model.mmProjUrl,
          mmProjSize: model.mmProjSize,
        } satisfies PendingDownloadMeta,
      };
      return {
        activeDownloads: nextActive,
        isDownloading: true,
        currentDownloadModelName: model.name,
        didUserCloseDownloadModal: false,
        resumableDownloads: nextResumable,
        pendingDownloadMeta: nextMeta,
        downloadProgress: nextProgress,
        downloadStats: nextStats,
        downloadPhase: nextPhase,
        pendingDownloads: [...s.pendingDownloads, model.name],
      };
    });

    // Clean up any existing FINAL file (stale partial write from a
    // failed prior attempt) but PRESERVE the .part file so the native
    // module can resume from it via HTTP Range. Skip when mmProjOnly —
    // the "stale" file is actually our completed main weights.
    if (!mmProjOnly) {
      try { await ReactNativeBlobUtil.fs.unlink(finalPath); } catch {}
    }

    try {
      const expectedBytes = parseFileSizeString(model.size || '');

      if (!mmProjOnly && NATIVE_DM_AVAILABLE) {
        // ─── PREFERRED PATH: expo-download-manager native module ───
        // Android: OkHttp. iOS: URLSession. Both stream to a .part file
        // and resume via HTTP Range, emitting the same progress events.
        //
        // Reads COLUMN_BYTES_DOWNLOADED_SO_FAR from DownloadManager.query()
        // every 500 ms on the Kotlin side and emits onDownloadProgress
        // events to JS with honest byte counts + EWMA speed + ETA. Runs
        // under a dataSync foreground service so aggressive OEM skins
        // don't kill multi-GB downloads under doze.
        installNativeDownloadListeners(set, get);

        // Seed the store with a zero-progress stat so the UI shows the
        // download row immediately instead of waiting for the first
        // event (~500 ms later).
        const startedAt = Date.now();
        set((s: any) => ({
          downloadProgress: { ...s.downloadProgress, [model.name]: 0 },
          downloadStats: {
            ...s.downloadStats,
            [model.name]: {
              bytesReceived: 0,
              bytesTotal: expectedBytes,
              bytesPerSec: 0,
              etaSeconds: null,
              startedAt,
            },
          },
        }));

        // The native side handles partial file cleanup, the foreground
        // service notification, and the broadcast receiver for
        // DOWNLOAD_COMPLETE. We just await the promise that resolves
        // when the native onDownloadComplete fires for our id.
        try {
          await nativeEnqueue({
            url: downloadUrl,
            destPath: finalPath,
            modelName: model.name,
            title: modelFile,
            isMainModel: true,
            mmProjUrl: model.mmProjUrl,
            mmProjSize: model.mmProjSize,
          });
        } catch (err: any) {
          // Native side reported an error via onDownloadError. Clear the
          // partial file and rethrow so the outer try/catch handles UI.
          try { await ReactNativeBlobUtil.fs.unlink(finalPath); } catch {}
          throw err;
        }

        // DownloadManager writes directly to finalPath, file is already at
        // the final location — no move needed.
      } else if (!mmProjOnly && Platform.OS === 'android') {
        // ─── FALLBACK PATH: react-native-blob-util + fs.stat polling ───
        //
        // Used only if the native module failed to link. The fs.stat
        // polling is fooled by DownloadManager's preallocation on many
        // devices (file size shows full target immediately), so we
        // have preallocation detection that flips to indeterminate
        // progress. Honest but visually less informative.
        const task = ReactNativeBlobUtil.config({
          addAndroidDownloads: {
            useDownloadManager: true,
            title: modelFile,
            description: 'Downloading model for MicroGPT',
            notification: true,
            path: finalPath,
            mime: 'application/octet-stream',
            mediaScannable: false,
          },
        }).fetch('GET', downloadUrl);

        set((s: any) => ({ _activeDownloadTasks: { ...s._activeDownloadTasks, [model.name]: task } }));

        // Initialize progress so the UI shows 0% immediately instead of
        // waiting for the first poll.
        const startedAt = Date.now();
        set((s: any) => ({
          downloadProgress: { ...s.downloadProgress, [model.name]: 0 },
          downloadStats: {
            ...s.downloadStats,
            [model.name]: {
              bytesReceived: 0,
              bytesTotal: expectedBytes,
              bytesPerSec: 0,
              etaSeconds: null,
              startedAt,
            },
          },
        }));

        // Poll the partial file size every 500 ms. Smooth bytes/sec with
        // an EWMA so the speed display doesn't flicker.
        //
        // IMPORTANT — DownloadManager preallocation:
        //   On Android 11+, system DownloadManager pre-allocates the
        //   destination file to its full expected size (sparse file via
        //   ftruncate) on kernels that support it. That makes stat().size
        //   return the full final size from the very first poll, which
        //   would make our progress jump to 100% immediately.
        //
        //   To detect this, we sample the file size on the first few
        //   polls. If the very first sample is already >= 95% of the
        //   expected size, we KNOW DownloadManager preallocated and we
        //   switch to indeterminate mode (encoded as progress: -1). The
        //   system notification still shows real progress because
        //   DownloadManager tracks its own byte counter internally; our
        //   polling just can't observe it without native code.
        //
        //   On devices where DownloadManager does NOT preallocate (older
        //   Android, some OEMs), the file grows from 0 and polling works.
        //
        //   The long-term fix is the expo-download-manager local module
        //   that reads DownloadManager.query() COLUMN_BYTES_DOWNLOADED_SO_FAR
        //   via native code — see modules/expo-download-manager/.
        let lastBytes = 0;
        let lastTime = startedAt;
        let smoothedBps = 0;
        let preallocDetected = false;
        let firstPoll = true;
        const POLL_MS = 500;
        const ALPHA = 0.3; // EWMA smoothing factor

        const poller = setInterval(async () => {
          try {
            // Stop polling if this model is no longer in the active set
            if (!get().activeDownloads.has(model.name)) {
              clearInterval(poller);
              return;
            }
            const exists = await ReactNativeBlobUtil.fs.exists(finalPath);
            if (!exists) return;
            const st = await ReactNativeBlobUtil.fs.stat(finalPath);
            const bytes = st?.size ?? 0;
            const now = Date.now();

            // Preallocation detection — run only on the first poll.
            if (firstPoll) {
              firstPoll = false;
              if (
                expectedBytes > 0 &&
                bytes >= expectedBytes * 0.95 &&
                now - startedAt < 3000
              ) {
                // File is already near-full on the very first poll, before
                // any plausible download could have completed. This is
                // DownloadManager preallocation. Switch to indeterminate.
                preallocDetected = true;
              }
            }

            if (preallocDetected) {
              // Indeterminate mode: progress = -1 (UI shows spinner).
              // Leave bytesTotal as expectedBytes for display context,
              // but don't claim we know bytesReceived. We intentionally
              // do NOT compute speed or ETA because we have no honest
              // signal — the file size isn't tracking downloaded bytes.
              set((s: any) => ({
                downloadProgress: {
                  ...s.downloadProgress,
                  [model.name]: -1,
                },
                downloadStats: {
                  ...s.downloadStats,
                  [model.name]: {
                    bytesReceived: 0,
                    bytesTotal: expectedBytes,
                    bytesPerSec: 0,
                    etaSeconds: null,
                    startedAt,
                  },
                },
              }));
              return;
            }

            const dt = (now - lastTime) / 1000;
            const dBytes = bytes - lastBytes;
            if (dt > 0 && dBytes >= 0) {
              const instantBps = dBytes / dt;
              smoothedBps =
                smoothedBps === 0
                  ? instantBps
                  : ALPHA * instantBps + (1 - ALPHA) * smoothedBps;
            }
            lastBytes = bytes;
            lastTime = now;

            const prevStats = get().downloadStats?.[model.name];
            const total = prevStats?.bytesTotal || expectedBytes || 0;
            let progress = 0;
            let etaSeconds: number | null = null;
            if (total > 0 && bytes > 0) {
              progress = Math.min(0.999, bytes / total);
              // Only report ETA once we have a meaningful speed sample
              // (at least 3 seconds of data and > 50 KB/s). This stops
              // the first tick from displaying a nonsensical "12 hours
              // left" because smoothedBps was nearly zero.
              const uptimeSec = (now - startedAt) / 1000;
              if (smoothedBps > 50 * 1024 && uptimeSec > 3) {
                const rawEta = (total - bytes) / smoothedBps;
                // Cap at 24h — anything longer is a speed-estimate artifact
                // and better hidden than shown.
                if (rawEta > 0 && rawEta < 24 * 3600) {
                  etaSeconds = Math.round(rawEta);
                }
              }
            } else if (bytes > 0) {
              // Total unknown — indeterminate marker (progress: -1).
              progress = -1;
            }

            set((s: any) => ({
              downloadProgress: { ...s.downloadProgress, [model.name]: progress },
              downloadStats: {
                ...s.downloadStats,
                [model.name]: {
                  bytesReceived: bytes,
                  bytesTotal: total,
                  bytesPerSec: smoothedBps,
                  etaSeconds,
                  startedAt,
                },
              },
            }));
          } catch {
            // Stat can transiently fail (e.g. file rename moment) — ignore
          }
        }, POLL_MS);

        set((s: any) => ({ _activeDownloadPollers: { ...s._activeDownloadPollers, [model.name]: poller } }));

        try {
          await task;
        } finally {
          clearInterval(poller);
          set((s: any) => { const p = { ...s._activeDownloadPollers }; delete p[model.name]; return { _activeDownloadPollers: p }; });
        }

        // DownloadManager writes directly to finalPath -- no move needed
      } else if (!mmProjOnly) {
        // iOS fallback: use regular fetch with the JS-side progress callback.
        // Same DownloadStats schema as the Android polling path so the UI
        // doesn't need to branch on platform.
        const task = ReactNativeBlobUtil.config({
          path: partialPath,
          fileCache: false,
          overwrite: true,
          followRedirect: true,
        }).fetch('GET', downloadUrl, {
          'User-Agent': 'MicroGPT/1.0',
        });

        set((s: any) => ({ _activeDownloadTasks: { ...s._activeDownloadTasks, [model.name]: task } }));

        const startedAt = Date.now();
        let lastBytes = 0;
        let lastTime = startedAt;
        let smoothedBps = 0;
        const ALPHA = 0.3;

        set((s: any) => ({
          downloadStats: {
            ...s.downloadStats,
            [model.name]: {
              bytesReceived: 0,
              bytesTotal: expectedBytes,
              bytesPerSec: 0,
              etaSeconds: null,
              startedAt,
            },
          },
        }));

        task.progress({ count: 10 }, (received: number, total: number) => {
          const bytesReceived = received;
          const bytesTotal = total > 0 ? total : expectedBytes;
          const now = Date.now();
          const dt = (now - lastTime) / 1000;
          const dBytes = bytesReceived - lastBytes;
          if (dt > 0 && dBytes >= 0) {
            const instantBps = dBytes / dt;
            smoothedBps =
              smoothedBps === 0
                ? instantBps
                : ALPHA * instantBps + (1 - ALPHA) * smoothedBps;
          }
          lastBytes = bytesReceived;
          lastTime = now;

          let progress = 0;
          let etaSeconds: number | null = null;
          if (bytesTotal > 0) {
            progress = Math.min(0.999, bytesReceived / bytesTotal);
            // Only emit ETA once the speed sample is reliable — avoids
            // the first tick showing nonsense like "12 hours left".
            const uptimeSec = (now - startedAt) / 1000;
            if (smoothedBps > 50 * 1024 && uptimeSec > 3) {
              const rawEta = (bytesTotal - bytesReceived) / smoothedBps;
              if (rawEta > 0 && rawEta < 24 * 3600) {
                etaSeconds = Math.round(rawEta);
              }
            }
          } else if (bytesReceived > 0) {
            progress = -1;
          }

          set((state: any) => ({
            downloadProgress: { ...state.downloadProgress, [model.name]: progress },
            downloadStats: {
              ...state.downloadStats,
              [model.name]: {
                bytesReceived,
                bytesTotal,
                bytesPerSec: smoothedBps,
                etaSeconds,
                startedAt,
              },
            },
          }));
        });

        const res = await task;
        const statusCode = res.info().status;
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`Server returned status ${statusCode}`);
        }

        // Rename .part -> .gguf
        await ReactNativeBlobUtil.fs.mv(partialPath, finalPath);
      }

      // Verify file exists and is valid
      const finalStat = await ReactNativeBlobUtil.fs.stat(finalPath);
      if (!finalStat || finalStat.size < 1024) {
        throw new Error('Downloaded file is too small — likely incomplete.');
      }

      // Download the vision projector (mmproj) if the model has one.
      //
      // CRITICAL — background-safety: this MUST also go through Android
      // DownloadManager, not regular fetch. Otherwise if the user
      // backgrounds the app during this secondary download, the fetch
      // promise is cancelled mid-transfer, the mmproj file is deleted,
      // and on the next load initMultimodal() fails silently — the
      // user sees "model loaded" but no camera button, with no error.
      // This was the reported "Gemma-4 E2B Vision loads but no camera"
      // bug.
      if (model.mmProjUrl) {
        const mmProjPath = `${downloadDir}/${model.name}.mmproj.gguf`;

        // Inner function to attempt a single mmproj download
        const attemptMmProjDownload = async () => {
          if (NATIVE_DM_AVAILABLE) {
            installNativeDownloadListeners(set, get);
            await nativeEnqueue({
              url: model.mmProjUrl!,
              destPath: mmProjPath,
              modelName: model.name,
              title: `${model.name} (vision projector)`,
              isMainModel: false,
            });
          } else if (Platform.OS === 'android') {
            const mmTask = ReactNativeBlobUtil.config({
              addAndroidDownloads: {
                useDownloadManager: true,
                title: `${model.name} (vision projector)`,
                description: 'Downloading vision projector for MicroGPT',
                notification: true,
                path: mmProjPath,
                mime: 'application/octet-stream',
                mediaScannable: false,
              },
            }).fetch('GET', model.mmProjUrl!);
            set((s: any) => ({ _activeDownloadTasks: { ...s._activeDownloadTasks, [model.name]: mmTask } }));
            await mmTask;
          } else {
            const mmRes = await ReactNativeBlobUtil.config({
              path: mmProjPath,
              fileCache: false,
              overwrite: true,
              followRedirect: true,
            }).fetch('GET', model.mmProjUrl!, {
              'User-Agent': 'MicroGPT/1.0',
            });
            const mmStatus = mmRes.info().status;
            if (mmStatus < 200 || mmStatus >= 300) {
              try { await ReactNativeBlobUtil.fs.unlink(mmProjPath); } catch {}
              throw new Error(`HTTP ${mmStatus} downloading vision projector`);
            }
          }
        };

        try {
          const mmProjExists = await ReactNativeBlobUtil.fs.exists(mmProjPath);
          let needsDownload = !mmProjExists;
          if (mmProjExists) {
            // Validate existing file — must be > 10KB to be a real projector
            const st = await ReactNativeBlobUtil.fs.stat(mmProjPath);
            if (!st || st.size < 10 * 1024) {
              try { await ReactNativeBlobUtil.fs.unlink(mmProjPath); } catch {}
              needsDownload = true;
            }
          }
          if (needsDownload) {
            const mmProjExpected = parseFileSizeString(model.mmProjSize || '');
            set((s: any) => ({
              downloadProgress: { ...s.downloadProgress, [model.name]: -1 },
              downloadPhase: { ...s.downloadPhase, [model.name]: 'downloading_projector' },
              downloadStats: {
                ...s.downloadStats,
                [model.name]: {
                  bytesReceived: 0,
                  bytesTotal: mmProjExpected,
                  bytesPerSec: 0,
                  etaSeconds: null,
                  startedAt: Date.now(),
                },
              },
            }));

            // Attempt download with one automatic retry on failure
            try {
              await attemptMmProjDownload();
            } catch (firstErr) {
              if (__DEV__) console.warn('[mmproj] first attempt failed, retrying:', firstErr);
              try { await ReactNativeBlobUtil.fs.unlink(mmProjPath); } catch {}
              await attemptMmProjDownload();
            }
          }

          // Validate the mmproj file — must be > 10KB to be a real projector
          const finalMmStat = await ReactNativeBlobUtil.fs.stat(mmProjPath).catch(() => null);
          if (!finalMmStat || finalMmStat.size < 10 * 1024) {
            try { await ReactNativeBlobUtil.fs.unlink(mmProjPath); } catch {}
            themedAlert(
              'Vision Projector Incomplete',
              `The vision projector for ${model.name} didn't finish downloading. Try re-downloading the model to enable image input.`
            );
          }
        } catch (mmErr) {
          if (__DEV__) console.warn('[mmproj download]', mmErr);
          try { await ReactNativeBlobUtil.fs.unlink(mmProjPath); } catch {}
          themedAlert(
            'Vision Projector Failed',
            `The vision projector for ${model.name} couldn't be downloaded. The model will still work for text — re-download the model later to enable image input.`
          );
        }
      }

      // Transition to verifying phase — bytes are done, now validating.
      set((s: any) => {
        const nextStats = { ...s.downloadStats };
        delete nextStats[model.name];
        return {
          downloadProgress: { ...s.downloadProgress, [model.name]: 1 },
          downloadStats: nextStats,
          downloadPhase: { ...s.downloadPhase, [model.name]: 'verifying' },
        };
      });

      // Sanity-check the final file exists and is non-trivially sized.
      // We DELIBERATELY do NOT compare against the catalog "size" string
      // here: that string is approximate (usually rounded to 1 decimal
      // place and may not match the server's real Content-Length), and
      // the native OkHttp downloader already verifies `.part` length
      // against the actual HTTP Content-Length before rename. Doing a
      // second imprecise check here just produces false positives on
      // fully-valid downloads.
      try {
        const exists = await ReactNativeBlobUtil.fs.exists(finalPath);
        if (!exists) {
          throw new Error('File missing after download reported complete');
        }
        const stat = await ReactNativeBlobUtil.fs.stat(finalPath);
        const actualSize = Number(stat?.size ?? 0);
        if (actualSize < 1024) {
          try { await ReactNativeBlobUtil.fs.unlink(finalPath); } catch {}
          throw new Error('Downloaded file is too small to be a valid GGUF');
        }
      } catch (verifyErr: any) {
        // Re-throw into the outer catch so finishDownload + partial
        // preservation happen uniformly with other error paths.
        throw verifyErr;
      }

      // Inspect the GGUF header to authoritatively classify the model —
      // this overrides the filename heuristic that ran at download time.
      // We do it here (just before the store update) so the initial
      // `models` push already carries the correct modelType and the UI
      // doesn't flash between types. The detector never throws — if it
      // fails, we keep whatever modelType the caller originally set.
      let resolvedModelType: ModelType | undefined = model.modelType;
      try {
        const probe = await detectGgufModelType(finalPath);
        if (probe.modelType) {
          resolvedModelType = probe.modelType;
          if (__DEV__ && probe.modelType !== model.modelType) {
            // eslint-disable-next-line no-console
            console.log(
              `[downloadModel] GGUF header classified "${model.name}" as ${probe.modelType} (arch=${probe.architecture}, source=${probe.source}) — was ${model.modelType ?? 'text'} from filename`,
            );
          }
        }
      } catch {}

      // Keep the original description if it's meaningful
      const finalDescription = model.description || 'Downloaded from Hugging Face';

      // If this is a .zip model (MNN format), unzip it to a directory
      // named after the model. The zip typically contains a folder with
      // clip.mnn, unet.mnn, vae_decoder.mnn, tokenizer.json, etc.
      // ImageGenerationView looks for a directory with unet.mnn to
      // detect MNN models and route to the local-dream engine.
      if (modelFile.endsWith('.zip')) {
        set((s: any) => ({
          downloadPhase: { ...s.downloadPhase, [model.name]: 'extracting' },
        }));
        try {
          // Extract to a temp dir first, then rename to the model name.
          // This is needed because MNN and QNN zips both extract to the
          // same internal folder name (e.g., "AbsoluteReality/"), but we
          // need different directories for MNN vs QNN models. By extracting
          // to a temp dir then renaming, we can use the model name
          // (e.g., "AbsoluteReality-NPU") as the final directory name.
          const tempExtractDir = `${downloadDir}/_extract_temp_${Date.now()}`;
          const finalModelDir = `${downloadDir}/${model.name}`;

          if (__DEV__) {
            // eslint-disable-next-line no-console
            console.log(`[downloadModel] Unzipping ${finalPath} → ${finalModelDir}`);
          }

          let StableDiffusion: any = null;
          try { StableDiffusion = require('expo-stable-diffusion'); } catch {}
          if (!StableDiffusion?.unzipModel) {
            throw new Error('Unzip not available — expo-stable-diffusion module not linked');
          }

          if (__DEV__) console.log(`[downloadModel] Starting unzip…`);
          await StableDiffusion.unzipModel(finalPath, tempExtractDir);
          if (__DEV__) console.log(`[downloadModel] Unzip complete`);

          // Move the extracted content to the final model directory.
          // We don't try to flatten nested structures here — the native
          // Kotlin loadModel() resolves nested dirs at load time by
          // recursively searching for unet.mnn / unet.bin. This handles
          // single-nested MNN zips and double-nested QNN zips alike.
          const extracted = await ReactNativeBlobUtil.fs.ls(tempExtractDir);
          if (__DEV__) console.log(`[downloadModel] Extracted contents: ${extracted.join(', ')}`);

          // Find the top-level subdirectory (zips usually have one)
          let topLevelDir: string | null = null;
          for (const f of extracted) {
            try {
              if (await ReactNativeBlobUtil.fs.isDir(`${tempExtractDir}/${f}`)) {
                topLevelDir = f;
                break;
              }
            } catch {}
          }

          const srcDir = topLevelDir ? `${tempExtractDir}/${topLevelDir}` : tempExtractDir;

          // Remove any existing directory with the target name
          try { await ReactNativeBlobUtil.fs.unlink(finalModelDir); } catch {}

          // Move to the final model name
          try {
            await ReactNativeBlobUtil.fs.mv(srcDir, finalModelDir);
          } catch {
            // mv might fail across mount points — copy recursively
            await ReactNativeBlobUtil.fs.mkdir(finalModelDir);
            const files = await ReactNativeBlobUtil.fs.ls(srcDir);
            for (const f of files) {
              const src = `${srcDir}/${f}`;
              const dst = `${finalModelDir}/${f}`;
              try {
                if (await ReactNativeBlobUtil.fs.isDir(src)) {
                  // For nested dirs (QNN structure), use mv for the subdir
                  await ReactNativeBlobUtil.fs.mv(src, dst);
                } else {
                  await ReactNativeBlobUtil.fs.cp(src, dst);
                }
              } catch { /* best effort */ }
            }
          }

          // Cleanup temp and zip
          try { await ReactNativeBlobUtil.fs.unlink(tempExtractDir); } catch {}
          try { await ReactNativeBlobUtil.fs.unlink(finalPath); } catch {}

          if (__DEV__) {
            const listRecursive = async (dir: string, depth: number): Promise<string[]> => {
              if (depth > 2) return [];
              const items = await ReactNativeBlobUtil.fs.ls(dir);
              const result: string[] = [];
              for (const item of items) {
                const full = `${dir}/${item}`;
                result.push(item);
                try {
                  if (await ReactNativeBlobUtil.fs.isDir(full)) {
                    const sub = await listRecursive(full, depth + 1);
                    result.push(...sub.map(s => `  ${item}/${s}`));
                  }
                } catch {}
              }
              return result;
            };
            const tree = await listRecursive(finalModelDir, 0);
            console.log(`[downloadModel] Final model dir ${finalModelDir}:\n${tree.join('\n')}`);
          }
        } catch (unzipErr: any) {
          if (__DEV__) console.warn('[downloadModel] Unzip failed:', unzipErr);
          themedAlert('Unzip Failed', `Downloaded but failed to extract: ${unzipErr?.message}`);
        }
      }

      // For ZIP models the zip file is deleted after extraction and the
      // model lives as a directory named model.name (e.g. "AbsoluteReality-NPU").
      // We must add the directory name to downloadedModels so the UI and
      // rescan logic can find it. For non-ZIP models the file stays as-is.
      const downloadedEntry = modelFile.endsWith('.zip') ? model.name : modelFile;
      const downloadedModel = {
        ...model,
        description: finalDescription,
        modelType: resolvedModelType,
      };
      // Built from the state at this moment, not from a snapshot taken
      // before the unzip: another download can finish while this one is
      // extracting, and its entries must survive.
      set((s: any) => ({
        models: [...s.models.filter((m: Model) => m.name !== model.name), downloadedModel],
        // Dedupe — on mmProjOnly resume the entry is already in the list
        // from the original main download.
        downloadedModels: s.downloadedModels.includes(downloadedEntry)
          ? s.downloadedModels
          : [...s.downloadedModels, downloadedEntry],
      }));
      // Through selectModel, not a bare `selectedModel`: in combo mode the
      // chat and image loaders watch their own slots, and a model set only
      // as `selectedModel` shows in the header but never loads.
      get().selectModel(downloadedModel);
      // Remove this model from the active set + clean up ALL download
      // state (progress, phase, stats, pollers). finishDownload now
      // deletes downloadProgress and downloadPhase entries so no stale
      // "100%" lingers in the store after the model appears in
      // downloadedModels and the UI switches to the "Use Model" button.
      finishDownload(set, get, model.name);
      // Drop the persisted resume meta — the .part is gone too.
      set((s: any) => {
        const nextMeta = { ...s.pendingDownloadMeta };
        delete nextMeta[model.name];
        return { pendingDownloadMeta: nextMeta };
      });
      try { await get().rescanResumableDownloads(); } catch {}

      showDownloadCompleteNotification(model.name);
    } catch (error: any) {
      const msg = error?.message || String(error) || 'Unknown error';
      const lower = msg.toLowerCase();
      const isCancelled = lower.includes('cancel');
      const isPaused = lower.includes('paus');
      if (__DEV__) console.warn('[Download Error]', msg);
      if (!isCancelled && !isPaused) {
        themedAlert(
          'Download Failed',
          `${msg}\n\nTap download again to resume from where it left off.`,
        );
      }

      // IMPORTANT: do NOT delete the .part file on error — our native
      // OkHttp downloader resumes from it via HTTP Range on the next
      // attempt. Only an explicit cancel from the user deletes the
      // partial (handled in cancelDownload).

      await get().rescanDownloadedModels();

      // Remove from active set + clean up UI state so the button works
      // again immediately for retry. finishDownload clears all download
      // state including progress and phase.
      finishDownload(set, get, model.name);
      // The .part is preserved — surface it as a resumable.
      try { await get().rescanResumableDownloads(); } catch {}
    }
  },

  cancelDownload: async (modelName) => {
    const { activeDownloads, _activeDownloadTasks, _activeDownloadPollers } = get();
    if (!activeDownloads.has(modelName)) return;

    try {
      // Cancel the blob-util fetch task if one exists for this model
      const task = _activeDownloadTasks[modelName];
      if (task) {
        try { task.cancel(); } catch {}
      }
      // Clear the polling timer if one exists
      const poller = _activeDownloadPollers[modelName];
      if (poller) {
        try { clearInterval(poller); } catch {}
      }
      // Cancel any native download(s) tracked for this model. The native
      // module's cancelDownload() removes the DownloadManager entry (which
      // deletes the partial file) and stops the foreground service if no
      // downloads remain.
      if (NATIVE_DM_AVAILABLE && ExpoDownloadManager) {
        const dm = ExpoDownloadManager;
        const matchingIds: number[] = [];
        nativeTrackingByDownloadId.forEach((track, id) => {
          if (track.modelName === modelName) matchingIds.push(id);
        });
        for (const id of matchingIds) {
          try { await dm.cancelDownload(id); } catch {}
          const t = nativeTrackingByDownloadId.get(id);
          // Reject the promise the caller is awaiting so downloadModel()
          // unwinds cleanly through its error handler.
          t?.reject?.(new Error('Canceled by user'));
          nativeTrackingByDownloadId.delete(id);
        }
      }
      const downloadDir = getDownloadDir();
      // Delete all possible file extensions for this model
      for (const ext of ['.gguf', '.safetensors', '.ckpt', '.zip']) {
        await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}${ext}.part`).catch(() => {});
        await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}${ext}`).catch(() => {});
      }
      await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}.mmproj.gguf`).catch(() => {});
    } catch {}

    finishDownload(set, get, modelName);
    set((s: any) => {
      const nextMeta = { ...s.pendingDownloadMeta };
      delete nextMeta[modelName];
      return {
        downloadProgress: { ...s.downloadProgress, [modelName]: 0 },
        pendingDownloadMeta: nextMeta,
      };
    });
    try { await get().rescanResumableDownloads(); } catch {}
  },

  pauseDownload: async (modelName) => {
    const { activeDownloads, _activeDownloadTasks, _activeDownloadPollers } = get();
    if (!activeDownloads.has(modelName)) return;

    try {
      const task = _activeDownloadTasks[modelName];
      if (task) { try { task.cancel(); } catch {} }
      const poller = _activeDownloadPollers[modelName];
      if (poller) { try { clearInterval(poller); } catch {} }

      if (NATIVE_DM_AVAILABLE && ExpoDownloadManager) {
        const dm = ExpoDownloadManager;
        const matchingIds: number[] = [];
        nativeTrackingByDownloadId.forEach((track, id) => {
          if (track.modelName === modelName) matchingIds.push(id);
        });
        for (const id of matchingIds) {
          try { await dm.pauseDownload(id); } catch {}
          const t = nativeTrackingByDownloadId.get(id);
          // Reject the awaiting downloadModel promise so it unwinds —
          // the message contains 'paused' so the catch path suppresses
          // its alert and leaves the .part file alone.
          t?.reject?.(new Error('Paused by user'));
          nativeTrackingByDownloadId.delete(id);
        }
      }
    } catch {}

    finishDownload(set, get, modelName);
    try { await get().rescanResumableDownloads(); } catch {}
  },

  resumeDownload: async (modelName) => {
    const state = get();
    const catalog = state.models.find((m: Model) => m.name === modelName);
    if (catalog) {
      await get().downloadModel(catalog);
      return;
    }
    const meta = state.pendingDownloadMeta?.[modelName];
    if (meta) {
      const synthetic: Model = {
        name: modelName,
        url: meta.url,
        description: meta.description ?? '',
        source: meta.source,
        size: meta.size,
        modelType: meta.modelType,
        mmProjUrl: meta.mmProjUrl,
        mmProjSize: meta.mmProjSize,
      };
      await get().downloadModel(synthetic);
      return;
    }
    themedAlert(
      'Cannot Resume',
      `Couldn't find the original URL for "${modelName}". Delete the partial file and start the download again.`,
    );
  },

  deletePartialDownload: async (modelName) => {
    const downloadDir = getDownloadDir();
    // Wipe both main-weight partials and the mmproj partial. Callers
    // pass the parent model name regardless of which one is on disk —
    // the UI treats them as a single resumable row.
    for (const ext of ['.gguf', '.safetensors', '.ckpt', '.zip']) {
      await ReactNativeBlobUtil.fs
        .unlink(`${downloadDir}/${modelName}${ext}.part`)
        .catch(() => {});
    }
    await ReactNativeBlobUtil.fs
      .unlink(`${downloadDir}/${modelName}.mmproj.gguf.part`)
      .catch(() => {});
    set((s: any) => {
      const nextMeta = { ...s.pendingDownloadMeta };
      delete nextMeta[modelName];
      const nextResumable = s.resumableDownloads.filter(
        (r: ResumableDownload) => r.modelName !== modelName,
      );
      return {
        pendingDownloadMeta: nextMeta,
        resumableDownloads: nextResumable,
      };
    });
  },

  rescanResumableDownloads: async () => {
    const downloadDir = getDownloadDir();
    try {
      const dirExists = await ReactNativeBlobUtil.fs.isDir(downloadDir);
      if (!dirExists) {
        set({ resumableDownloads: [] });
        return;
      }
      const entries = await ReactNativeBlobUtil.fs.ls(downloadDir);
      const state = get();
      const active = state.activeDownloads as Set<string>;
      const catalogByName = new Map<string, Model>();
      for (const m of state.models as Model[]) catalogByName.set(m.name, m);
      const meta = state.pendingDownloadMeta as Record<string, PendingDownloadMeta>;

      // First pass: bucket every `.part` file by its parent model name.
      // Each model gets at most one main partial and at most one mmproj
      // partial — we choose which one to surface in the second pass.
      type Bucket = { mainPart?: string; mmPart?: string };
      const buckets = new Map<string, Bucket>();
      for (const f of entries) {
        if (!f.endsWith('.part')) continue;
        const fileName = f.replace(/\.part$/, '');
        const isMmproj = /\.mmproj\.gguf$/i.test(fileName);
        const modelName = isMmproj
          ? fileName.replace(/\.mmproj\.gguf$/i, '')
          : fileName.replace(/\.(gguf|safetensors|ckpt|zip)$/i, '');
        const b = buckets.get(modelName) ?? {};
        if (isMmproj) b.mmPart = f; else b.mainPart = f;
        buckets.set(modelName, b);
      }

      const list: ResumableDownload[] = [];
      for (const [modelName, b] of buckets) {
        if (active.has(modelName)) continue;

        // Decide which `.part` to surface:
        //   • main `.part` exists → always show that. If a stray mmproj
        //     `.part` is also there, ignore it — the main download has
        //     to finish first, and our flow retries mmproj after.
        //   • only mmproj `.part` → surface ONLY if the main weights are
        //     actually complete on disk; otherwise we'd be promising a
        //     resume we can't deliver.
        let chosenPartFile: string | undefined;
        let mmprojOnly = false;

        if (b.mainPart) {
          chosenPartFile = b.mainPart;
        } else if (b.mmPart) {
          // Confirm the corresponding main file is complete (size > 1 KB
          // is the same floor used elsewhere as "is this a real model").
          let mainExists = false;
          for (const ext of ['.gguf', '.safetensors', '.ckpt']) {
            try {
              const st = await ReactNativeBlobUtil.fs.stat(`${downloadDir}/${modelName}${ext}`);
              if (st && Number(st.size) > 1024) { mainExists = true; break; }
            } catch {}
          }
          if (mainExists) {
            chosenPartFile = b.mmPart;
            mmprojOnly = true;
          }
          // else: bare mmproj partial with no main weights — can't act on
          // it, but leave the file on disk in case the user re-downloads
          // and it gets cleaned up via the normal flow.
        }
        if (!chosenPartFile) continue;

        try {
          const fullPath = `${downloadDir}/${chosenPartFile}`;
          const stat = await ReactNativeBlobUtil.fs.stat(fullPath);
          const size = Number(stat?.size ?? 0);
          if (size <= 1024) continue;

          // Orphan = nothing in catalog, nothing in persisted meta. We
          // can't synthesize a URL → UI hides Resume and offers Delete.
          const hasCatalog = catalogByName.has(modelName);
          const hasMeta = !!meta?.[modelName];
          const orphan = !hasCatalog && !hasMeta;

          list.push({
            modelName,
            fileName: chosenPartFile.replace(/\.part$/, ''),
            bytesOnDisk: size,
            lastModifiedMs: Number(stat?.lastModified ?? 0),
            mmprojOnly: mmprojOnly || undefined,
            orphan: orphan || undefined,
          });
        } catch {}
      }
      list.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
      set({ resumableDownloads: list });
    } catch (e) {
      if (__DEV__) console.warn('[rescanResumableDownloads]', e);
    }
  },

  deleteModel: async (modelName) => {
    const state = get();
    const modelToDelete = state.models.find((m: Model) => m.name === modelName);
    if (!modelToDelete) {
      themedAlert('Error', 'Model not found in store.');
      return;
    }

    // Unload the model first if it's currently selected/loaded to avoid
    // file descriptor leaks and potential native crashes.
    if (state.selectedModel?.name === modelName) {
      try {
        if (isImageGenModel(modelToDelete)) {
          let StableDiffusion: any = null;
          try { StableDiffusion = require('expo-stable-diffusion'); } catch {}
          if (StableDiffusion?.unloadModel) await StableDiffusion.unloadModel();
        }
      } catch {}
    }

    const downloadDir = getDownloadDir();
    try {
      // Delete all possible file extensions for this model
      for (const ext of ['.gguf', '.safetensors', '.ckpt', '.zip']) {
        await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}${ext}`).catch(() => {});
        await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}${ext}.part`).catch(() => {});
      }
      // Delete the associated mmproj (vision projector) file if it exists
      await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}.mmproj.gguf`).catch(() => {});
      // Delete extracted model directory (MNN/QNN models unzipped from .zip)
      await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${modelName}`).catch(() => {});
      // Also try the base name without -MNN/-NPU suffix (older extractions)
      const baseName = modelName.replace(/-(MNN|NPU)$/, '');
      if (baseName !== modelName) {
        await ReactNativeBlobUtil.fs.unlink(`${downloadDir}/${baseName}`).catch(() => {});
      }
      await state.rescanDownloadedModels();
    } catch (error) {
      if (__DEV__) console.warn('Could not delete file:', error);
    }

    // Remove ALL extension variants AND bare directory name for this model
    const newDownloaded = state.downloadedModels.filter(
      (f: string) => {
        if (f === modelName) return false; // directory name (MNN/QNN)
        const base = f.replace(/\.(gguf|safetensors|ckpt|zip)$/i, '');
        return base !== modelName;
      }
    );

    let updatedModels = state.models;
    if (modelToDelete.source === 'huggingface' || modelToDelete.source === 'local') {
      updatedModels = state.models.filter((m: Model) => m.name !== modelName);
    }

    let newSelectedModel = state.selectedModel;
    if (newSelectedModel?.name === modelName) newSelectedModel = null;
    let newActiveCharacter = state.activeCharacter;
    if (newActiveCharacter?.modelName === modelName) newActiveCharacter = null;

    // Also clear combo mode slots if the deleted model was in them
    const newTextModel = state.selectedTextModel?.name === modelName ? null : state.selectedTextModel;
    const newImageGenModel = state.selectedImageGenModel?.name === modelName ? null : state.selectedImageGenModel;

    set({
      models: updatedModels,
      downloadedModels: newDownloaded,
      selectedModel: newSelectedModel,
      selectedTextModel: newTextModel,
      selectedImageGenModel: newImageGenModel,
      activeCharacter: newActiveCharacter,
    });

    themedAlert('Deleted', `${modelName} removed from your device.`);
  },

  selectModel: (model) => {
    const state = get();
    if (state.comboModeEnabled && model) {
      // In combo mode, route by type — don't clear the other slot
      if (isImageGenModel(model)) {
        set(() => ({
          selectedImageGenModel: model,
          selectedModel: model,
        }));
      } else {
        set(() => ({
          selectedTextModel: model,
          selectedModel: model,
          activeCharacter: null,
        }));
      }
    } else {
      // Legacy exclusive mode — clear both slots, set the one
      if (model && isImageGenModel(model)) {
        set(() => ({
          selectedModel: model,
          selectedTextModel: null,
          selectedImageGenModel: model,
          activeCharacter: null,
        }));
      } else {
        set(() => ({
          selectedModel: model,
          selectedTextModel: model,
          selectedImageGenModel: null,
          activeCharacter: null,
        }));
      }
    }
  },

  selectTextModel: (model) => {
    set(() => ({
      selectedTextModel: model,
      // When clearing text model, fall back selectedModel to image model if present
      selectedModel: model ?? get().selectedImageGenModel ?? null,
      activeCharacter: null,
    }));
  },

  selectImageGenModel: (model) => {
    set(() => ({
      selectedImageGenModel: model,
      // When clearing image model, keep selectedModel as text model
      // When setting, only update selectedModel if no text model loaded
      selectedModel: get().selectedTextModel ?? model,
    }));
  },

  setComboMode: (enabled) => {
    if (!enabled) {
      // When disabling combo mode, clear the image gen slot
      set({ comboModeEnabled: false, selectedImageGenModel: null });
    } else {
      set({ comboModeEnabled: true });
    }
  },

  addLocalModel: async (
    fileUri: string,
    fileName: string,
    hintedType?: 'text' | 'imageGen',
  ) => {
    try {
      // Supported extensions:
      //  .gguf            — text LLM, vision LLM, or sd.cpp image gen
      //  .safetensors     — always image gen (sd.cpp CPU path)
      //  .ckpt            — always image gen
      //  .zip             — MNN or QNN image-gen bundle; extracts to a
      //                     directory, inner engine is picked by the
      //                     native loader from unet.mnn / unet.bin.
      const extMatch = fileName.match(/\.(gguf|safetensors|ckpt|zip)$/i);
      const ext = extMatch ? extMatch[0].toLowerCase() : '.gguf';
      const modelName = fileName.replace(/\.(gguf|safetensors|ckpt|zip)$/i, '').trim();
      const isZip = ext === '.zip';
      const isSafetensorsLike = ext === '.safetensors' || ext === '.ckpt';

      const downloadDir = getDownloadDir();
      const dirExists = await ReactNativeBlobUtil.fs.isDir(downloadDir);
      if (!dirExists) await ReactNativeBlobUtil.fs.mkdir(downloadDir);

      const destPath = `${downloadDir}/${modelName}${ext}`;
      await ReactNativeBlobUtil.fs.cp(fileUri, destPath);

      // ── Classify ───────────────────────────────────────────────
      // safetensors/ckpt → always imageGen (no text LLM ever ships
      // in these formats on-device).
      // zip → imageGen (MNN or QNN bundle); inner engine decided by
      // native loader from unet.mnn / unet.bin presence.
      // gguf → prefer GGUF header probe (authoritative), fall back
      // to filename heuristic. The user's hint only tie-breaks when
      // the probe is inconclusive; if they chose "text" but the
      // file is clearly image-gen by header, we trust the header.
      let resolvedModelType: ModelType | undefined;

      if (isSafetensorsLike || isZip) {
        resolvedModelType = 'imageGen';
      } else {
        // .gguf — prefer header.
        try {
          const probe = await detectGgufModelType(destPath);
          if (probe.modelType) resolvedModelType = probe.modelType;
        } catch {}
        if (!resolvedModelType) {
          if (detectImageGenFromFilename(modelName)) {
            resolvedModelType = 'imageGen';
          } else if (hintedType) {
            resolvedModelType = hintedType === 'imageGen' ? 'imageGen' : undefined;
          }
        }
      }

      // ── Extract .zip so the native loader can find unet.mnn /
      //    unet.bin. Matches what downloadModel() does for catalog
      //    ZIPs. If extraction fails, the single-file path still
      //    exists on disk; the user can delete and retry. ──
      if (isZip) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const SD = require('expo-stable-diffusion');
          if (SD?.unzipModel) {
            const tempExtractDir = `${downloadDir}/_extract_temp_${Date.now()}`;
            const finalModelDir = `${downloadDir}/${modelName}`;
            await SD.unzipModel(destPath, tempExtractDir);
            // Flatten single-nested folder if present
            const ls = await ReactNativeBlobUtil.fs.ls(tempExtractDir);
            const finalExists = await ReactNativeBlobUtil.fs.isDir(finalModelDir);
            if (finalExists) {
              try { await ReactNativeBlobUtil.fs.unlink(finalModelDir); } catch {}
            }
            if (ls.length === 1) {
              const onlyChild = `${tempExtractDir}/${ls[0]}`;
              if (await ReactNativeBlobUtil.fs.isDir(onlyChild)) {
                await ReactNativeBlobUtil.fs.mv(onlyChild, finalModelDir);
              } else {
                await ReactNativeBlobUtil.fs.mv(tempExtractDir, finalModelDir);
              }
            } else {
              await ReactNativeBlobUtil.fs.mv(tempExtractDir, finalModelDir);
            }
            try { await ReactNativeBlobUtil.fs.unlink(tempExtractDir); } catch {}
            // Keep the zip on disk or remove? Remove to save space —
            // the extracted directory is the loadable artifact now.
            try { await ReactNativeBlobUtil.fs.unlink(destPath); } catch {}
          } else if (__DEV__) {
            console.warn('[addLocalModel] unzipModel not available; leaving .zip unextracted');
          }
        } catch (zipErr) {
          if (__DEV__) console.warn('[addLocalModel] zip extraction failed:', zipErr);
          themedAlert(
            'Zip Extraction Failed',
            'The file was copied but could not be extracted. MNN / QNN models need to be extracted to a folder with unet.mnn or unet.bin inside.',
          );
        }
      }

      await get().rescanDownloadedModels();

      const isImageGen = resolvedModelType === 'imageGen';
      set((state: any) => {
        const newModels = state.models.filter((m: Model) => m.name !== modelName);
        newModels.push({
          name: modelName,
          url: destPath,
          description: isImageGen
            ? isZip
              ? 'Local image gen model (MNN/QNN bundle)'
              : 'Local image generation model loaded from device'
            : 'Local model loaded from device',
          source: 'local',
          modelType: isImageGen ? 'imageGen' : undefined,
        });
        return { models: newModels };
      });
    } catch (err) {
      if (__DEV__) console.warn('Error adding local model:', err);
      themedAlert('Error', 'Failed to copy local model into Downloads folder.');
    }
  },
});

export default createModelsSlice;
