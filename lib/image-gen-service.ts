// lib/image-gen-service.ts
//
// Thin stateful wrapper around expo-stable-diffusion for shared use by
// both ImageGenerationView (standalone mode) and combo mode (inline chat).
// Single source of truth for SD pipeline state — prevents double-loads
// and serializes load/unload via a mutex.

import ReactNativeBlobUtil from 'react-native-blob-util';
import * as StableDiffusion from 'expo-stable-diffusion';
import { npuCoordinator } from './npu-coordinator';
import { validateModelFile } from './gguf-detect';
import { getModelsDir, getLegacyModelsDir } from './storage-paths';

// ─── Types ──────────────────────────────────────────────────────────

export type GenerateParams = {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
};

export type ProgressEvent = {
  step: number;
  totalSteps: number;
  backend?: string;
};

// ─── Internal state ─────────────────────────────────────────────────

let loadedModelName: string | null = null;
let loadMutex: Promise<void> = Promise.resolve();
// Name of the most-recently-requested model (regardless of mutex
// position). Lets queued load attempts skip themselves when the user
// has already moved on to a different target — avoids the case where
// tapping A → B mid-load makes A finish loading completely before
// being unloaded for B.
let latestRequestedName: string | null = null;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Recommended (steps, cfg) defaults by model family.
 */
export function pickDefaults(modelName: string): { steps: number; cfg: number } {
  const lower = modelName.toLowerCase();
  if (lower.includes('turbo')) return { steps: 4, cfg: 1.0 };
  if (lower.includes('lcm')) return { steps: 6, cfg: 2.0 };
  return { steps: 12, cfg: 7.5 };
}

/**
 * Resolve a model's on-disk path. Searches for MNN/QNN directories
 * and single-file models in both download locations.
 */
async function resolveModelPath(modelName: string): Promise<string> {
  const newDir = getModelsDir();
  const oldDir = getLegacyModelsDir();

  const namesToTry = [
    modelName,
    modelName.replace(/-MNN$/, ''),
    modelName.replace(/-NPU$/, ''),
  ];
  // Marker files that identify a model *directory*:
  //   Android (local-dream): unet.mnn (MNN/GPU) or unet.bin (QNN/NPU)
  //   iOS (Core ML): Unet.mlmodelc or UnetChunk1.mlmodelc (SDXL split)
  const unetFiles = ['unet.mnn', 'unet.bin', 'Unet.mlmodelc', 'UnetChunk1.mlmodelc'];

  const findMarkerFile = async (dir: string, depth: number): Promise<boolean> => {
    if (depth > 3) return false;
    try {
      const files = await ReactNativeBlobUtil.fs.ls(dir);
      for (const marker of unetFiles) {
        if (files.includes(marker)) return true;
      }
      for (const f of files) {
        try {
          const sub = `${dir}/${f}`;
          if (await ReactNativeBlobUtil.fs.isDir(sub)) {
            if (await findMarkerFile(sub, depth + 1)) return true;
          }
        } catch {}
      }
    } catch {}
    return false;
  };

  // Check for MNN/QNN directory first
  for (const dir of [newDir, oldDir]) {
    for (const name of namesToTry) {
      const modelDir = `${dir}/${name}`;
      try {
        if (await ReactNativeBlobUtil.fs.isDir(modelDir)) {
          if (await findMarkerFile(modelDir, 0)) {
            return modelDir;
          }
        }
      } catch {}
    }
  }

  // Single-file models
  const exts = ['.safetensors', '.gguf', '.ckpt'];
  for (const ext of exts) {
    for (const dir of [newDir, oldDir]) {
      const candidate = `${dir}/${modelName}${ext}`;
      try {
        if (await ReactNativeBlobUtil.fs.exists(candidate)) {
          return candidate;
        }
      } catch {}
    }
  }

  throw new Error(`Model not found: ${modelName}`);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Check if the SD binary is available in this build.
 * Returns null on success, or an error message string.
 */
export function diagnoseBinary(): string | null {
  try {
    const diag = StableDiffusion.hello();
    if (diag === 'missing-binary') {
      return 'Image generation binary not found in the app.';
    }
    if (diag.startsWith('not-extracted')) {
      return 'Image generation binary is in the APK but was not extracted. Reinstall the app.';
    }
    return null;
  } catch (err: any) {
    return `Image generation module not linked: ${err?.message ?? String(err)}`;
  }
}

export function isImageModelLoaded(): boolean {
  return loadedModelName !== null;
}

export function getLoadedModelName(): string | null {
  return loadedModelName;
}

/**
 * QNN/NPU graphs are baked at a fixed 512×512 latent shape — passing
 * any other size to the local-dream binary produces pixelated garbage
 * because the binary doesn't reject the mismatch, it just runs the
 * graph against a wrong-shape input. See xororz/local-dream README:
 *   "For SD1.5, fixed 512×512 base model shape, more shapes available
 *    using patches."
 * This helper lets callers (UI, combo handler) snap their size picker
 * to a value the model can actually produce.
 */
export function isNpuModel(modelName: string | null): boolean {
  return !!modelName && modelName.endsWith('-NPU');
}

/**
 * iOS Core ML Stable Diffusion models are compiled at a fixed latent shape
 * (512×512 for the SD1.5/2.1 base repos we ship). Like NPU models, callers
 * must not offer arbitrary sizes — the pipeline ignores them and the
 * generated image is always the baked resolution.
 */
export function isCoreMLModel(modelName: string | null): boolean {
  return !!modelName && modelName.endsWith('-CoreML');
}

/** True when the model's output resolution is fixed at 512×512. */
export function isFixedSizeModel(modelName: string | null): boolean {
  return isNpuModel(modelName) || isCoreMLModel(modelName);
}

/**
 * Load an image generation model. Skips if the same model is already loaded.
 * Serialized via mutex to prevent concurrent load/unload races.
 *
 * Note: the "already loaded?" check happens INSIDE the mutex, never
 * outside — an outer fast-path return races with a pending unload
 * queued behind us. The symptom is "Model loaded, server ready" being
 * logged, then a stale unload finishing right after, leaving the
 * subprocess stopped while JS state says it's ready. Next generate
 * call then fails with "No image model loaded".
 */
export async function loadImageModel(modelName: string): Promise<void> {
  // Mark this as the most-recent request BEFORE waiting. Any queued
  // older requests will see they're stale once they reach the mutex.
  latestRequestedName = modelName;
  console.log(`[image-gen-service] load requested: ${modelName}`);

  const prev = loadMutex;
  let release!: () => void;
  loadMutex = new Promise<void>((r) => { release = r; });
  await prev;

  try {
    // Stale request? User asked for something else after we queued.
    // Don't waste CPU loading a model the user no longer wants.
    if (latestRequestedName !== modelName) {
      console.log(`[image-gen-service] superseded — "${modelName}" stale, latest is "${latestRequestedName}"`);
      return;
    }

    // Same-model fast path, but only after we own the mutex — so any
    // pending unload has already drained.
    if (loadedModelName === modelName) {
      console.log(`[image-gen-service] "${modelName}" already loaded — skip`);
      return;
    }

    // Unload any existing model first
    const prevWasNpu = isNpuModel(loadedModelName);
    if (loadedModelName) {
      console.log(`[image-gen-service] unloading "${loadedModelName}" before loading "${modelName}"`);
      try { await StableDiffusion.unloadModel(); } catch {}
      loadedModelName = null;
      if (prevWasNpu) npuCoordinator.releaseImage();
    }

    const binaryError = diagnoseBinary();
    if (binaryError) throw new Error(binaryError);

    const path = await resolveModelPath(modelName);

    // Validate single-file image models (safetensors / ckpt / gguf)
    // before handing them to sd-server. Same rationale as the GGUF
    // text path: a truncated download passed to a native parser
    // takes the whole app down with no JS-side recovery. Directories
    // (MNN / QNN) skip this check via the validator's default.
    const validation = await validateModelFile(path);
    if (!validation.ok) {
      throw new Error(
        `Model file failed integrity check: ${validation.reason}. ` +
        `Delete and redownload "${modelName}" to fix.`,
      );
    }

    // For NPU models, claim the Hexagon DSP first. If the LLM is currently
    // on HTP, this evicts it (the eviction handler reloads the text model
    // on GPU/CPU) and waits a settle window for FastRPC teardown before
    // we attach the QNN backend. Non-NPU image models skip this entirely.
    const newIsNpu = isNpuModel(modelName);
    if (newIsNpu) {
      console.log('[image-gen-service] Acquiring NPU for image model:', modelName);
      await npuCoordinator.acquireForImage();
    }

    console.log(`[image-gen-service] loading "${modelName}" at ${path}`);
    try {
      await StableDiffusion.loadModel(path);
      // After the native load returns, check once more that the user
      // didn't change their mind during the load. If they did, the
      // newly-queued load will unload us anyway — but logging the
      // wasted work helps diagnose UX complaints.
      if (latestRequestedName !== modelName) {
        console.log(`[image-gen-service] "${modelName}" finished loading but user moved on to "${latestRequestedName}" — will be unloaded next`);
      }
      loadedModelName = modelName;
      console.log(`[image-gen-service] "${modelName}" loaded`);
    } catch (err) {
      // Native load failed — release NPU ownership we just claimed so a
      // subsequent text-on-NPU load can proceed.
      if (newIsNpu) npuCoordinator.releaseImage();
      throw err;
    }
  } finally {
    release();
  }
}

/**
 * Unload the currently loaded image model. Safe to call if nothing is loaded.
 */
export async function unloadImageModel(): Promise<void> {
  const prev = loadMutex;
  let release!: () => void;
  loadMutex = new Promise<void>((r) => { release = r; });
  await prev;

  try {
    // Check inside mutex — outside-the-mutex check races with pending loads
    if (!loadedModelName) return;
    const priorName = loadedModelName;
    const wasNpu = isNpuModel(loadedModelName);
    console.log(`[image-gen-service] unloading "${priorName}"`);
    await StableDiffusion.unloadModel();
    loadedModelName = null;
    // Also clear latestRequestedName if it matches what we just unloaded —
    // otherwise a subsequent loadImageModel(priorName) would short-circuit
    // via the same-name check.
    if (latestRequestedName === priorName) latestRequestedName = null;
    if (wasNpu) npuCoordinator.releaseImage();
    console.log(`[image-gen-service] unloaded "${priorName}"`);
  } catch (err) {
    console.warn('[image-gen-service] Unload error (non-fatal):', err);
    const wasNpu = isNpuModel(loadedModelName);
    loadedModelName = null;
    latestRequestedName = null;
    if (wasNpu) npuCoordinator.releaseImage();
  } finally {
    release();
  }
}

/**
 * Generate an image. Returns base64 PNG string.
 * The model must be loaded first via loadImageModel().
 *
 * For NPU models we override width/height to 512 even if the caller
 * passed something else — the QNN graph is baked at 512×512 and any
 * other size produces pixelated output. This is a safety net so combo
 * mode (and any future caller) can't accidentally pass the wrong size.
 */
export async function generateImage(params: GenerateParams): Promise<string> {
  if (!loadedModelName) {
    throw new Error('No image model loaded');
  }
  const seed = params.seed ?? Math.floor(Math.random() * 2147483647);
  const fixed = isFixedSizeModel(loadedModelName);
  const width = fixed ? 512 : (params.width ?? 256);
  const height = fixed ? 512 : (params.height ?? 256);
  if (fixed && (params.width !== 512 || params.height !== 512)) {
    console.log(`[image-gen-service] fixed-size model: forcing 512x512 (caller asked for ${params.width}x${params.height})`);
  }
  const base64 = await StableDiffusion.generate({
    prompt: params.prompt,
    negativePrompt: params.negativePrompt ?? 'blurry, low quality, distorted, deformed, ugly, bad anatomy',
    width,
    height,
    steps: params.steps ?? 12,
    cfgScale: params.cfgScale ?? 7.5,
    seed,
  });
  return base64;
}

export async function cancelGeneration(): Promise<void> {
  try {
    await StableDiffusion.cancelGeneration();
  } catch (err: any) {
    console.warn('[image-gen-service] Cancel error (non-fatal):', err?.message);
  }
}

/**
 * Register a progress listener. Returns a subscription with a .remove() method.
 */
export function addProgressListener(cb: (event: ProgressEvent) => void) {
  return StableDiffusion.addProgressListener(cb);
}

/**
 * Save a base64 PNG to the image_history directory and return the file:// URI.
 */
export async function saveGeneratedImage(base64: string): Promise<string> {
  const historyDir = `${ReactNativeBlobUtil.fs.dirs.DocumentDir}/image_history`;
  await ReactNativeBlobUtil.fs.mkdir(historyDir).catch(() => {});
  const imgFile = `${historyDir}/gen-${Date.now()}.png`;
  await ReactNativeBlobUtil.fs.writeFile(imgFile, base64, 'base64');
  return `file://${imgFile}`;
}

/**
 * Copy a generated image (file:// URI from saveGeneratedImage, or a raw
 * base64 string) into the public Downloads/MicroGPT folder and notify
 * the media scanner so it shows up in the gallery. Returns the saved
 * absolute path. Used by long-press handlers in the chat / image-gen
 * surfaces to let users keep an image they like.
 */
export async function saveImageToGallery(source: string): Promise<string> {
  const dir = getModelsDir();
  await ReactNativeBlobUtil.fs.mkdir(dir).catch(() => {});
  const dest = `${dir}/microgpt-${Date.now()}.png`;

  if (source.startsWith('file://')) {
    await ReactNativeBlobUtil.fs.cp(source.replace(/^file:\/\//, ''), dest);
  } else if (source.startsWith('/')) {
    await ReactNativeBlobUtil.fs.cp(source, dest);
  } else {
    // Assume base64
    await ReactNativeBlobUtil.fs.writeFile(dest, source, 'base64');
  }

  try {
    // Android: tell the media scanner so the image shows in the Gallery.
    // No-op on iOS.
    await (ReactNativeBlobUtil as any).fs.scanFile?.([{ path: dest, mime: 'image/png' }]);
  } catch {
    // Scanner is best-effort — file is still saved either way.
  }

  return dest;
}
