// lib/gguf-detect.ts
//
// Pure-JS GGUF header inspector. Given a path to a downloaded .gguf
// file on disk, reads the first 512 KB (never more), parses the binary
// metadata block, and classifies the file as a text LLM, vision LLM,
// or image generation model.
//
// Why pure JS:
//   - Works on any React Native/Expo build without extra native code
//   - No JNI bindings, no CocoaPods changes, no Kotlin/Swift
//   - Only touches a tiny slice of the file (512 KB), so performance is
//     fine even on multi-gigabyte models
//   - `general.architecture` is always near the start of the metadata
//     block in practice — we've never seen it land outside 512 KB
//
// Why not just use filename heuristics?
//   - Filename patterns catch ~99% of popular models but fail on
//     edge cases (random HF uploads, custom naming, etc.)
//   - A GGUF header's `general.architecture` key is authoritative —
//     it's set by whichever tool wrote the file (llama.cpp's convert.py,
//     stable-diffusion.cpp's converter, unsloth, etc.) and directly
//     identifies the model family
//
// Format reference:
//   - https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
//   - Magic: 'GGUF' (0x47 0x47 0x55 0x46)
//   - Version (uint32 LE)
//   - Tensor count (uint64 LE for v2+, uint32 LE for v1)
//   - Metadata KV count (same)
//   - Repeated KV pairs: string key + uint32 type + value

import ReactNativeBlobUtil from 'react-native-blob-util';
import type { ModelType } from '@/store';
import { LLAMA_CPP_ARCHS } from './llama-archs.generated';

/** Bytes read from the head of the GGUF file. 512 KB is a safe ceiling —
 *  `general.architecture` typically lands within the first 100 bytes. */
const HEADER_READ_BYTES = 512 * 1024;

/**
 * Text LLM architectures: every `general.architecture` value the bundled
 * llama.cpp can load. Generated from the installed llama.rn (see
 * scripts/gen-llama-archs.js) so it can't drift from the engine.
 */
const TEXT_LLM_ARCHS = new Set<string>(LLAMA_CPP_ARCHS);

/** True when the bundled llama.cpp can load this `general.architecture`. */
export function isSupportedTextArch(architecture: string): boolean {
  return TEXT_LLM_ARCHS.has(architecture.toLowerCase());
}

/**
 * Known image generation architectures. stable-diffusion.cpp's converter
 * writes these into `general.architecture`, as do other diffusion-model
 * converters. Kept deliberately broad to catch SD 1.x through Flux.
 */
const IMAGE_GEN_ARCHS = new Set<string>([
  'sd1',
  'sd2',
  'sdxl',
  'sd3',
  'sd3.5',
  'sd3m',
  'flux',
  'flux1',
  'flux2',
  'flux-dev',
  'flux-schnell',
  'flux-klein',
  'wan',
  'wan2',
  'lumina',
  'lumina2',
  'chroma',
  'qwen_image',
  'qwen-image',
  'z_image',
  'z-image',
  'pixart',
  'pixart-alpha',
  'pixart-sigma',
  'hunyuan-dit',
  'hunyuan_dit',
  'stable-diffusion',
  'stablediffusion',
  'stable_diffusion',
  'diffusion',
  'ovis-image',
  'anima',
]);

/**
 * Validate that a file on disk is a structurally-sound GGUF.
 *
 * Catches the common failure mode where a download was interrupted /
 * truncated / partial — the file exists with a .gguf extension but is
 * either too small to contain a header or is missing the magic bytes.
 * Without this check, we'd hand a corrupt file straight to llama.rn's
 * native init and llama.cpp would crash inside parsing, taking the app
 * down with it (no JS try/catch can save us from a native abort).
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, reason }` with a
 * user-visible reason string. Never throws.
 *
 * Cheap — only reads the first 4 bytes for the magic + the on-disk size.
 */
export async function validateGgufFile(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const exists = await ReactNativeBlobUtil.fs.exists(filePath);
    if (!exists) return { ok: false, reason: 'file missing on disk' };

    const stat = await ReactNativeBlobUtil.fs.stat(filePath);
    const size = Number(stat?.size ?? 0);
    // Smallest plausible real GGUF (a tiny tokenizer-only file) is
    // hundreds of KB; anything under 1 MB is certainly a partial /
    // error-page download.
    if (size < 1024 * 1024) {
      return { ok: false, reason: `file is only ${size} bytes — download was likely truncated` };
    }

    const bytes = await readFileHeader(filePath);
    if (!bytes || bytes.length < 4) {
      return { ok: false, reason: 'could not read file header' };
    }
    // GGUF magic: 'G' 'G' 'U' 'F' = 0x47 0x47 0x55 0x46
    if (bytes[0] !== 0x47 || bytes[1] !== 0x47 || bytes[2] !== 0x55 || bytes[3] !== 0x46) {
      const got = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
        .replace(/[^\x20-\x7e]/g, '?');
      return { ok: false, reason: `not a GGUF file (header bytes: "${got}")` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'validation failed' };
  }
}

/**
 * Validate a safetensors file. Format:
 *   [0..8]   uint64 LE — JSON header byte length (`headerLen`)
 *   [8..8+headerLen]  utf-8 JSON object describing tensors
 *   [...]    raw tensor data
 *
 * We check that headerLen is in a sane range AND that the file is at
 * least `8 + headerLen + 1` bytes long. This catches truncated downloads
 * before sd.cpp does (sd.cpp tends to crash on short headers).
 */
export async function validateSafetensorsFile(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const exists = await ReactNativeBlobUtil.fs.exists(filePath);
    if (!exists) return { ok: false, reason: 'file missing on disk' };

    const stat = await ReactNativeBlobUtil.fs.stat(filePath);
    const size = Number(stat?.size ?? 0);
    if (size < 1024 * 1024) {
      return { ok: false, reason: `file is only ${size} bytes — download was likely truncated` };
    }

    const bytes = await readFileHeader(filePath);
    if (!bytes || bytes.length < 8) {
      return { ok: false, reason: 'could not read file header' };
    }

    // Read uint64 LE without BigInt. Header lengths in practice fit
    // well inside 53 bits (JS safe integer) — typical model headers
    // are 100 KB to ~10 MB; the upper 5 bytes are ~always zero.
    const lo =
      bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    const hi =
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    // Combine as float (safe for up to 2^53)
    const headerLen = (lo >>> 0) + (hi >>> 0) * 0x100000000;

    if (!Number.isFinite(headerLen) || headerLen <= 0) {
      return { ok: false, reason: 'invalid safetensors header length' };
    }
    // Reasonable upper bound — model headers are at most a few MB
    if (headerLen > 100 * 1024 * 1024) {
      return { ok: false, reason: `safetensors header claims ${headerLen} bytes (implausibly large)` };
    }
    if (size < 8 + headerLen + 1) {
      return { ok: false, reason: `file truncated (size ${size}, header claims ${headerLen} bytes)` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'validation failed' };
  }
}

/**
 * Validate a .ckpt (PyTorch checkpoint) file. CKPTs come in two flavors:
 *   - Modern: ZIP archive of pickled tensors. Starts with `PK\x03\x04`.
 *   - Legacy: raw pickle stream. Starts with the pickle protocol marker
 *     `\x80\x02` (proto 2), `\x80\x03` (proto 3), `\x80\x04` (proto 4),
 *     or `\x80\x05` (proto 5).
 *
 * We accept either prefix. Anything else is a wrong/truncated file.
 */
export async function validateCkptFile(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const exists = await ReactNativeBlobUtil.fs.exists(filePath);
    if (!exists) return { ok: false, reason: 'file missing on disk' };

    const stat = await ReactNativeBlobUtil.fs.stat(filePath);
    const size = Number(stat?.size ?? 0);
    if (size < 1024 * 1024) {
      return { ok: false, reason: `file is only ${size} bytes — download was likely truncated` };
    }

    const bytes = await readFileHeader(filePath);
    if (!bytes || bytes.length < 4) {
      return { ok: false, reason: 'could not read file header' };
    }

    // ZIP-based: PK\x03\x04
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    // Pickle: 0x80 followed by protocol number 2..5
    const isPickle =
      bytes[0] === 0x80 && bytes[1] >= 0x02 && bytes[1] <= 0x05;

    if (!isZip && !isPickle) {
      const got = `${bytes[0].toString(16)} ${bytes[1].toString(16)} ${bytes[2].toString(16)} ${bytes[3].toString(16)}`;
      return { ok: false, reason: `not a ckpt file (header bytes: ${got})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'validation failed' };
  }
}

/**
 * Validate any model file by picking the right validator from the file
 * extension. Returns ok:true for unknown extensions / directories so
 * callers don't get false negatives on MNN/QNN model directories or
 * future formats we don't yet validate.
 */
export async function validateModelFile(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.gguf')) return validateGgufFile(filePath);
  if (lower.endsWith('.safetensors')) return validateSafetensorsFile(filePath);
  if (lower.endsWith('.ckpt')) return validateCkptFile(filePath);
  // Unknown extension or directory — skip validation rather than fail.
  return { ok: true };
}

export type GgufDetectionResult = {
  /** The raw `general.architecture` value, or null if parsing failed. */
  architecture: string | null;
  /** Our classification. May be null if we couldn't match the arch. */
  modelType: ModelType | null;
  /** Source of the classification — useful for debugging. */
  source: 'gguf-arch' | 'gguf-arch-heuristic' | 'parse-failed';
  /**
   * Number of multi-token-prediction (MTP / NextN) layers in the file, from
   * `<arch>.nextn_predict_layers`. 0 when the model has none. A positive
   * value means llama.rn can run MTP speculative decoding on it.
   */
  mtpLayers: number;
};

/**
 * Classify a downloaded .gguf file by reading its binary header.
 * Always resolves — never throws — so callers can use the result as an
 * optional signal without wrapping in try/catch.
 */
export async function detectGgufModelType(
  filePath: string,
): Promise<GgufDetectionResult> {
  try {
    const bytes = await readFileHeader(filePath);
    if (!bytes || bytes.length < 24) {
      return { architecture: null, modelType: null, source: 'parse-failed', mtpLayers: 0 };
    }
    const { architecture: arch, mtpLayers } = parseHeader(bytes);
    if (!arch) {
      return { architecture: null, modelType: null, source: 'parse-failed', mtpLayers: 0 };
    }
    const lower = arch.toLowerCase();

    // Strict match first — the arch key was set by a converter we know about
    if (TEXT_LLM_ARCHS.has(lower)) {
      return { architecture: arch, modelType: 'text', source: 'gguf-arch', mtpLayers };
    }
    if (IMAGE_GEN_ARCHS.has(lower)) {
      return { architecture: arch, modelType: 'imageGen', source: 'gguf-arch', mtpLayers: 0 };
    }

    // Heuristic fallback on unknown archs. If the arch string *looks* like
    // a diffusion model, bet on imageGen; otherwise default to text since
    // llama.cpp gains new text LLM architectures faster than sd.cpp gains
    // new image ones.
    if (
      lower.includes('diffusion') ||
      lower.includes('flux') ||
      /^sd[\-_]?\d/.test(lower) ||
      lower.startsWith('sdxl') ||
      lower.includes('pixart') ||
      lower.includes('lumina') ||
      lower.includes('wan')
    ) {
      return {
        architecture: arch,
        modelType: 'imageGen',
        source: 'gguf-arch-heuristic',
        mtpLayers: 0,
      };
    }

    // Unknown arch that isn't obviously diffusion — bet on text.
    return { architecture: arch, modelType: 'text', source: 'gguf-arch-heuristic', mtpLayers };
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[gguf-detect] failed to classify', filePath, err);
    }
    return { architecture: null, modelType: null, source: 'parse-failed', mtpLayers: 0 };
  }
}

/* ════════════════════════════════════════════════════════════════════
   File-reading side
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Read the first [HEADER_READ_BYTES] of a file into a Uint8Array.
 * Uses fs.slice to avoid base64-decoding multi-gigabyte files.
 */
async function readFileHeader(filePath: string): Promise<Uint8Array | null> {
  const cacheDir = ReactNativeBlobUtil.fs.dirs.CacheDir;
  const tmpPath = `${cacheDir}/gguf-probe-${Date.now()}-${Math.floor(Math.random() * 1e6)}.bin`;

  try {
    // Make sure the source file exists and is big enough to bother
    const exists = await ReactNativeBlobUtil.fs.exists(filePath);
    if (!exists) return null;

    const stat = await ReactNativeBlobUtil.fs.stat(filePath);
    const fileSize = Number(stat?.size ?? 0);
    if (fileSize < 24) return null;

    const sliceEnd = Math.min(fileSize, HEADER_READ_BYTES);
    await ReactNativeBlobUtil.fs.slice(filePath, tmpPath, 0, sliceEnd);

    const b64 = await ReactNativeBlobUtil.fs.readFile(tmpPath, 'base64');
    return base64ToBytes(b64);
  } finally {
    try {
      await ReactNativeBlobUtil.fs.unlink(tmpPath);
    } catch {
      // temp file may not exist if slice failed — ignore
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  // React Native's Hermes has globalThis.atob. On older runtimes we fall
  // back to a tiny manual decoder to avoid depending on Buffer (which
  // pulls in the whole Node polyfill).
  const decode: (s: string) => string =
    typeof (globalThis as any).atob === 'function'
      ? (globalThis as any).atob.bind(globalThis)
      : manualAtob;
  const binary = decode(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function manualAtob(input: string): string {
  const str = input.replace(/=+$/, '');
  let output = '';
  let bs = 0;
  let bc = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = B64_ALPHABET.indexOf(String.fromCharCode(c));
    if (v < 0) continue;
    bs = (bs << 6) | v;
    bc += 6;
    if (bc >= 8) {
      bc -= 8;
      output += String.fromCharCode((bs >> bc) & 0xff);
    }
  }
  return output;
}

/* ════════════════════════════════════════════════════════════════════
   GGUF parser
   ═══════════════════════════════════════════════════════════════════ */

// GGUF metadata value types (from the spec).
const GGUF_VT_UINT8 = 0;
const GGUF_VT_INT8 = 1;
const GGUF_VT_UINT16 = 2;
const GGUF_VT_INT16 = 3;
const GGUF_VT_UINT32 = 4;
const GGUF_VT_INT32 = 5;
const GGUF_VT_FLOAT32 = 6;
const GGUF_VT_BOOL = 7;
const GGUF_VT_STRING = 8;
const GGUF_VT_ARRAY = 9;
const GGUF_VT_UINT64 = 10;
const GGUF_VT_INT64 = 11;
const GGUF_VT_FLOAT64 = 12;

/**
 * Walk the GGUF metadata block and pull out `general.architecture` and
 * `<arch>.nextn_predict_layers`. Stops at the first `tokenizer.*` key:
 * converters write the general and architecture keys before the
 * tokenizer, whose vocabulary arrays run past the read window anyway.
 * Whatever was found before a truncated or malformed value is returned;
 * `architecture` stays null if the file isn't a GGUF or the key never
 * appears within the read window.
 */
export function parseHeader(bytes: Uint8Array): { architecture: string | null; mtpLayers: number } {
  const result = { architecture: null as string | null, mtpLayers: 0 };
  if (bytes.length < 24) return result;
  // Magic: 'GGUF' = 0x47 0x47 0x55 0x46
  if (
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x47 ||
    bytes[2] !== 0x55 ||
    bytes[3] !== 0x46
  ) {
    return result;
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4;

  // Version (uint32 LE)
  const version = dv.getUint32(pos, true);
  pos += 4;
  if (version < 1 || version > 16) return result; // sanity guard

  // v1: tensor_count + kv_count are uint32
  // v2+: both are uint64
  let kvCount: number;
  if (version === 1) {
    pos += 4; // skip tensor_count
    kvCount = dv.getUint32(pos, true);
    pos += 4;
  } else {
    pos += 8; // skip tensor_count
    kvCount = readU64AsNumber(dv, pos);
    pos += 8;
  }

  // Walk KV pairs. We give up at the first read beyond our buffer.
  for (let i = 0; i < kvCount; i++) {
    const keyRead = readString(bytes, dv, pos);
    if (!keyRead) return result;
    pos = keyRead.next;
    if (keyRead.value.startsWith('tokenizer.')) return result;

    if (pos + 4 > bytes.length) return result;
    const valueType = dv.getUint32(pos, true);
    pos += 4;

    if (keyRead.value === 'general.architecture') {
      if (valueType !== GGUF_VT_STRING) return result;
      const valRead = readString(bytes, dv, pos);
      if (!valRead) return result;
      result.architecture = valRead.value;
      pos = valRead.next;
      continue;
    }

    if (keyRead.value.endsWith('.nextn_predict_layers')) {
      if (
        (valueType === GGUF_VT_UINT32 || valueType === GGUF_VT_INT32) &&
        pos + 4 <= bytes.length
      ) {
        result.mtpLayers = Math.max(0, dv.getInt32(pos, true));
      }
    }

    const skipped = skipValue(bytes, dv, pos, valueType);
    if (skipped === null) return result;
    pos = skipped;
  }

  return result;
}

function readU64AsNumber(dv: DataView, pos: number): number {
  // JS safely represents integers up to 2^53. GGUF counts (tensor count,
  // kv count, string length) never approach that in practice, so a
  // lossy conversion is fine.
  const lo = dv.getUint32(pos, true);
  const hi = dv.getUint32(pos + 4, true);
  return hi * 0x100000000 + lo;
}

function readString(
  bytes: Uint8Array,
  dv: DataView,
  pos: number,
): { value: string; next: number } | null {
  if (pos + 8 > bytes.length) return null;
  const len = readU64AsNumber(dv, pos);
  pos += 8;
  // Sanity cap — a single metadata string over 4 MB is almost certainly
  // a corrupted file, or we've wandered off the valid header.
  if (len < 0 || len > 4 * 1024 * 1024) return null;
  if (pos + len > bytes.length) return null;
  const slice = bytes.subarray(pos, pos + len);
  let value: string;
  try {
    value =
      typeof TextDecoder !== 'undefined'
        ? new TextDecoder('utf-8', { fatal: false }).decode(slice)
        : String.fromCharCode(...slice);
  } catch {
    return null;
  }
  return { value, next: pos + len };
}

function skipValue(
  bytes: Uint8Array,
  dv: DataView,
  pos: number,
  valueType: number,
): number | null {
  switch (valueType) {
    case GGUF_VT_UINT8:
    case GGUF_VT_INT8:
    case GGUF_VT_BOOL:
      return pos + 1 <= bytes.length ? pos + 1 : null;
    case GGUF_VT_UINT16:
    case GGUF_VT_INT16:
      return pos + 2 <= bytes.length ? pos + 2 : null;
    case GGUF_VT_UINT32:
    case GGUF_VT_INT32:
    case GGUF_VT_FLOAT32:
      return pos + 4 <= bytes.length ? pos + 4 : null;
    case GGUF_VT_UINT64:
    case GGUF_VT_INT64:
    case GGUF_VT_FLOAT64:
      return pos + 8 <= bytes.length ? pos + 8 : null;
    case GGUF_VT_STRING: {
      const r = readString(bytes, dv, pos);
      return r ? r.next : null;
    }
    case GGUF_VT_ARRAY: {
      if (pos + 4 + 8 > bytes.length) return null;
      const elemType = dv.getUint32(pos, true);
      pos += 4;
      const arrLen = readU64AsNumber(dv, pos);
      pos += 8;
      // Hard cap on array length to avoid pathological OOB walks.
      if (arrLen < 0 || arrLen > 1_000_000) return null;
      for (let i = 0; i < arrLen; i++) {
        const next = skipValue(bytes, dv, pos, elemType);
        if (next === null) return null;
        pos = next;
        if (pos > bytes.length) return null;
      }
      return pos;
    }
    default:
      return null;
  }
}
