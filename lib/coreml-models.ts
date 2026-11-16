// lib/coreml-models.ts
//
// iOS-only image-generation catalog + downloader (Apple Core ML).
//
// Android downloads single-file GGUF/MNN/NPU image models. iOS uses Apple's
// Core ML Stable Diffusion, whose models are *directories* of compiled
// `.mlmodelc` bundles published on HuggingFace. Rather than ship a native
// unzip (which would mean vendoring a zlib shim), we use the full-precision
// Apple repos that store the compiled model as individual files under
// `split_einsum/compiled/…` and download each file to its relative path —
// reconstructing the directory the Core ML pipeline expects.
//
// This module is imported only on iOS paths; nothing here touches Android.

import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { getModelsDir } from './storage-paths';
import type { Model } from '@/store';

// ── Catalog ──────────────────────────────────────────────────────────
// Apple's official full-precision Core ML SD repos. Full precision (vs.
// the palettized repos) stores the compiled model as individual files, so
// no archive extraction is required. `size` is approximate (the real total
// is summed from the HF tree at download time).
export type CoreMLVariant = 'split_einsum' | 'original';
type CoreMLRepo = {
  name: string;
  repo: string;
  description: string;
  size: string;
  /**
   * split_einsum → ANE-optimized, needs A14+ (iPhone 12+).
   * original → CPU/GPU, runs on older chips (e.g. iPhone 11 / A13).
   * Derived back from the "-CPU" name suffix at download/load time.
   */
  variant: CoreMLVariant;
};

// Only SD 2.1-base ships on iOS: its training set was NSFW-filtered, and
// iOS doesn't run the output classifier yet (see docs/CONTENT-SAFETY.md).
// SD 1.5 readily produces nudity, so it stays off until NsfwFilter is ported.
const COREML_REPOS: CoreMLRepo[] = [
  {
    name: 'SD-2.1-base-CoreML',
    repo: 'apple/coreml-stable-diffusion-2-1-base',
    description: 'Stable Diffusion 2.1 · 512×512 · Neural Engine (iPhone 12+)',
    size: '2.6 GB',
    variant: 'split_einsum',
  },
  {
    name: 'SD-2.1-base-CoreML-CPU',
    repo: 'apple/coreml-stable-diffusion-2-1-base',
    description: 'Stable Diffusion 2.1 · 512×512 · CPU/GPU (older devices)',
    size: '2.6 GB',
    variant: 'original',
  },
];

/** ANE models are named plainly; CPU/GPU ones carry a "-CPU" suffix. */
export function coreMLVariantForName(name: string): CoreMLVariant {
  return name.endsWith('-CPU') ? 'original' : 'split_einsum';
}

/**
 * iOS image-gen catalog as `Model` entries. Marked with `coremlRepo` so the
 * store routes them to the multi-file Core ML downloader, and
 * `modelType: 'imageGen'` so the rest of the app treats them as image
 * models. Empty on non-iOS.
 */
export const IOS_COREML_MODELS: Model[] =
  Platform.OS === 'ios'
    ? COREML_REPOS.map((r) => ({
        name: r.name,
        url: `https://huggingface.co/${r.repo}`,
        description: r.description,
        source: 'builtIn' as const,
        size: r.size,
        modelType: 'imageGen' as const,
        coremlRepo: r.repo,
      }))
    : [];

// ── HuggingFace tree enumeration ─────────────────────────────────────

type HFTreeEntry = {
  type: 'file' | 'directory';
  path: string;
  size?: number;
  lfs?: { size: number };
};

export type CoreMLFile = { relativePath: string; url: string; size: number };

async function fetchTree(repo: string, path = ''): Promise<HFTreeEntry[]> {
  const url = path
    ? `https://huggingface.co/api/models/${repo}/tree/main/${path}`
    : `https://huggingface.co/api/models/${repo}/tree/main`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF tree ${repo}/${path}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Enumerate every compiled-model file under `split_einsum/compiled` for a
 * repo, returning each with the path relative to `compiled/` (so it lands
 * as `<modelDir>/TextEncoder.mlmodelc/…`). Skips `.zip` archives and the
 * `analytics` folders. Subdirectories are fetched in parallel.
 */
export async function enumerateCoreMLFiles(
  repo: string,
  variant: CoreMLVariant = 'split_einsum',
): Promise<CoreMLFile[]> {
  const top = await fetchTree(repo);
  const vDir = top.find((e) => e.type === 'directory' && e.path === variant);
  if (!vDir) throw new Error(`${repo}: no ${variant} directory`);

  const vEntries = await fetchTree(repo, variant);
  const compiled = vEntries.find(
    (e) => e.type === 'directory' && e.path === `${variant}/compiled`,
  );
  if (!compiled) throw new Error(`${repo}: no ${variant}/compiled directory`);

  const base = compiled.path; // "<variant>/compiled"
  const out: CoreMLFile[] = [];

  // Components we intentionally skip to save ~1.5 GB per model. All are
  // backed by ml-stable-diffusion's resource-loading logic:
  //   • Unet.mlmodelc — the monolithic UNet; the pipeline prefers the
  //     chunked UnetChunk1/2 (ANE) whenever both chunks exist, which they
  //     always do in Apple's split_einsum repos.
  //   • VAEEncoder.mlmodelc — only used for image-to-image; we do txt2img.
  //   • SafetyChecker.mlmodelc — optional; we run with disableSafety.
  const SKIP_TOP_DIRS = new Set([
    `${base}/Unet.mlmodelc`,
    `${base}/VAEEncoder.mlmodelc`,
    `${base}/SafetyChecker.mlmodelc`,
  ]);

  async function walk(dirPath: string, depth = 5): Promise<void> {
    if (depth <= 0) return;
    const entries = await fetchTree(repo, dirPath);
    const subdirs: string[] = [];
    for (const e of entries) {
      if (e.type === 'file') {
        if (e.path.endsWith('.zip')) continue; // we download files, not archives
        const relativePath = e.path.startsWith(`${base}/`)
          ? e.path.slice(base.length + 1)
          : e.path;
        out.push({
          relativePath,
          url: `https://huggingface.co/${repo}/resolve/main/${e.path}`,
          size: e.lfs?.size ?? e.size ?? 0,
        });
      } else if (
        e.type === 'directory' &&
        !e.path.endsWith('/analytics') &&
        !SKIP_TOP_DIRS.has(e.path)
      ) {
        subdirs.push(e.path);
      }
    }
    await Promise.all(subdirs.map((d) => walk(d, depth - 1)));
  }

  await walk(base);
  return out;
}

// ── Multi-file download ──────────────────────────────────────────────

export type CoreMLProgress = {
  bytesDownloaded: number;
  bytesTotal: number;
  /** 0..1, or -1 when total is unknown */
  fraction: number;
};

/**
 * Download every file of a Core ML model into `<modelsDir>/<model.name>/`,
 * preserving relative paths so the result is a valid Core ML resources dir.
 * Files already present at the right size are skipped (cheap resume).
 * `onProgress` reports aggregate bytes across all files. Honors
 * `isCancelled()` between files.
 */
export async function downloadCoreMLModel(
  model: Model,
  opts: { onProgress?: (p: CoreMLProgress) => void; isCancelled?: () => boolean } = {},
): Promise<string> {
  if (!model.coremlRepo) throw new Error(`${model.name} is not a Core ML model`);
  const { onProgress, isCancelled } = opts;

  const modelDir = `${getModelsDir()}/${model.name}`;
  await ReactNativeBlobUtil.fs.mkdir(modelDir).catch(() => {});

  const files = await enumerateCoreMLFiles(model.coremlRepo, coreMLVariantForName(model.name));
  if (files.length === 0) throw new Error(`${model.name}: no Core ML files found`);
  const bytesTotal = files.reduce((s, f) => s + f.size, 0);

  let bytesDone = 0;
  const emit = (extra = 0) =>
    onProgress?.({
      bytesDownloaded: bytesDone + extra,
      bytesTotal,
      fraction: bytesTotal > 0 ? Math.min(0.999, (bytesDone + extra) / bytesTotal) : -1,
    });
  emit();

  for (const f of files) {
    if (isCancelled?.()) throw new Error('cancelled');

    const dest = `${modelDir}/${f.relativePath}`;
    const parent = dest.slice(0, dest.lastIndexOf('/'));
    await ReactNativeBlobUtil.fs.mkdir(parent).catch(() => {});

    // Skip if already downloaded at the expected size.
    try {
      const st = await ReactNativeBlobUtil.fs.stat(dest);
      if (st && f.size > 0 && Number(st.size) === f.size) {
        bytesDone += f.size;
        emit();
        continue;
      }
      // Wrong size — remove and refetch.
      await ReactNativeBlobUtil.fs.unlink(dest).catch(() => {});
    } catch {
      // not present
    }

    const task = ReactNativeBlobUtil.config({
      path: dest,
      fileCache: false,
      overwrite: true,
      followRedirect: true,
    }).fetch('GET', f.url, { 'User-Agent': 'MicroGPT/1.0' });

    task.progress({ count: 20 }, (received: number) => emit(received));

    const res = await task;
    const status = res.info().status;
    if (status < 200 || status >= 300) {
      await ReactNativeBlobUtil.fs.unlink(dest).catch(() => {});
      throw new Error(`HTTP ${status} downloading ${f.relativePath}`);
    }
    bytesDone += f.size > 0 ? f.size : Number((await ReactNativeBlobUtil.fs.stat(dest)).size);
    emit();
  }

  return modelDir;
}
