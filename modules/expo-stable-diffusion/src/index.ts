// modules/expo-stable-diffusion/src/index.ts
//
// TypeScript wrapper over the ExpoStableDiffusion native module.
//
// One JS contract over three engines, picked from the model's format:
// sd-server (stable-diffusion.cpp, CPU) and local-dream (MNN/OpenCL GPU or
// QNN/Hexagon NPU) on Android, Apple Core ML on iOS. See ./README.md.
//
//   1. loadModel(path)       → a .gguf/.safetensors file, or a model directory
//   2. generate(params)      → text-to-image, returns PNG bytes base64
//   3. unloadModel()         → free the ~1-2 GB of RAM the pipeline holds
//
// Progress is streamed via the `onGenerationProgress` event (one event
// per diffusion step). Errors bubble through `onGenerationError`.

import { requireNativeModule, EventEmitter } from 'expo-modules-core';

const ExpoStableDiffusion = requireNativeModule('ExpoStableDiffusion');

// ============================================================
// Types
// ============================================================

export type GenerateParams = {
  /** The user's text prompt. */
  prompt: string;
  /** Things to avoid in the image (e.g. "blurry, low quality"). */
  negativePrompt?: string;
  /** Image width in pixels. Must be a multiple of 8. Default 512. */
  width?: number;
  /** Image height in pixels. Must be a multiple of 8. Default 512. */
  height?: number;
  /** Denoising steps. More = higher quality, slower. 4-8 for turbo/LCM, 20-30 for base SD. */
  steps?: number;
  /** Classifier-free guidance scale. 1.0 for turbo, 7.5 for standard SD. */
  cfgScale?: number;
  /** RNG seed; omit or set to -1 for a random seed each run. */
  seed?: number;
};

export type GenerationProgressEvent = {
  /** The current step (1-indexed). */
  step: number;
  /** Total number of steps for this run. */
  totalSteps: number;
  /** Which engine is active: 'localdream' (GPU/NPU) or 'sdcpp' (CPU) */
  engine?: string;
  /** Which backend: 'OpenCL' (GPU), 'QNN' (NPU), or 'CPU' */
  backend?: string;
};

export type GenerationErrorEvent = {
  message: string;
};

// ============================================================
// API
// ============================================================

/**
 * Sanity check — returns "ready" from the native side plus which engine
 * binaries were found and the detected SoC / QNN variant.
 */
export function hello(): string {
  return ExpoStableDiffusion.hello();
}

/**
 * Load a Stable Diffusion model from an absolute file path. Blocks until
 * the model is fully parsed and the pipeline is warm. Expected to take
 * 5-30 seconds depending on quantization and device speed.
 *
 * Call unloadModel() before loading a different model — the library only
 * holds one pipeline at a time and re-loading without unloading wastes
 * memory during the transition.
 *
 * @param path Absolute path to a .gguf / .safetensors SD checkpoint.
 */
export async function loadModel(path: string): Promise<void> {
  await ExpoStableDiffusion.loadModel(path);
}

/**
 * Release the currently loaded model and free its ~1-2 GB of RAM.
 * Safe to call when nothing is loaded (no-op).
 */
export async function unloadModel(): Promise<void> {
  await ExpoStableDiffusion.unloadModel();
}

/**
 * Returns true if a model is currently loaded and ready to generate.
 */
export function isLoaded(): boolean {
  return ExpoStableDiffusion.isLoaded();
}

/**
 * Generate an image from a text prompt. Resolves with a base64-encoded
 * PNG when generation finishes, or rejects with an error.
 *
 * Progress events fire via addProgressListener() — subscribe before
 * calling generate() if you want step-by-step updates for the UI.
 */
export async function generate(params: GenerateParams): Promise<string> {
  const result = await ExpoStableDiffusion.generate(
    params.prompt,
    params.negativePrompt ?? '',
    params.width ?? 512,
    params.height ?? 512,
    params.steps ?? 20,
    params.cfgScale ?? 7.5,
    params.seed ?? -1,
  );
  return result;
}

/**
 * Request cancellation of the in-flight generation. The promise returned
 * from generate() will reject shortly after. Safe to call when nothing
 * is generating (no-op).
 */
export async function cancelGeneration(): Promise<void> {
  await ExpoStableDiffusion.cancelGeneration();
}

/**
 * Unzip a downloaded .zip model file to a destination directory.
 * Uses Java's built-in java.util.zip on Android — no external deps.
 */
export async function unzipModel(
  zipPath: string,
  destDir: string,
): Promise<void> {
  await ExpoStableDiffusion.unzipModel(zipPath, destDir);
}

// ============================================================
// Event listeners
// ============================================================

type SdEvents = {
  onGenerationProgress: (event: GenerationProgressEvent) => void;
  onGenerationError: (event: GenerationErrorEvent) => void;
};

const emitter = new EventEmitter<SdEvents>(ExpoStableDiffusion);

export function addProgressListener(
  callback: (event: GenerationProgressEvent) => void,
) {
  return emitter.addListener('onGenerationProgress', callback);
}

export function addErrorListener(
  callback: (event: GenerationErrorEvent) => void,
) {
  return emitter.addListener('onGenerationError', callback);
}
