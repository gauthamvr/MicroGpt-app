import { isSupportedTextArch, parseHeader } from '../lib/gguf-detect';
import { LLAMA_RN_VERSION } from '../lib/llama-archs.generated';

jest.mock('react-native-blob-util', () => ({ __esModule: true, default: { fs: {} } }));

const VT = { UINT32: 4, INT32: 5, STRING: 8, ARRAY: 9, UINT64: 10 } as const;

type Kv =
  | { key: string; type: typeof VT.STRING; value: string }
  | { key: string; type: typeof VT.UINT32 | typeof VT.INT32; value: number }
  | { key: string; type: typeof VT.UINT64; value: number }
  | { key: string; type: typeof VT.ARRAY; value: string[] };

/** Build the head of a GGUF v3 file: magic, version, counts, metadata. */
function gguf(kvs: Kv[], declaredKvCount = kvs.length): Uint8Array {
  const bytes: number[] = [];
  const u32 = (n: number) => bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const u64 = (n: number) => { u32(n); u32(0); };
  const str = (s: string) => {
    const utf8 = Array.from(Buffer.from(s, 'utf8'));
    u64(utf8.length);
    bytes.push(...utf8);
  };

  bytes.push(0x47, 0x47, 0x55, 0x46);
  u32(3);
  u64(0);
  u64(declaredKvCount);
  for (const kv of kvs) {
    str(kv.key);
    u32(kv.type);
    if (kv.type === VT.STRING) str(kv.value);
    else if (kv.type === VT.UINT64) u64(kv.value);
    else if (kv.type === VT.ARRAY) {
      u32(VT.STRING);
      u64(kv.value.length);
      kv.value.forEach(str);
    } else u32(kv.value);
  }
  return Uint8Array.from(bytes);
}

const arch = (value: string): Kv => ({ key: 'general.architecture', type: VT.STRING, value });

describe('parseHeader', () => {
  test('reads the architecture of a plain model', () => {
    const bytes = gguf([
      arch('qwen35'),
      { key: 'general.name', type: VT.STRING, value: 'Qwen3.5-0.8B' },
      { key: 'qwen35.block_count', type: VT.UINT32, value: 24 },
      { key: 'tokenizer.ggml.model', type: VT.STRING, value: 'gpt2' },
    ]);
    expect(parseHeader(bytes)).toEqual({ architecture: 'qwen35', mtpLayers: 0 });
  });

  // Key order copied from unsloth/Qwen3.5-0.8B-MTP-GGUF: the MTP layer
  // count is the last architecture key, right before the tokenizer.
  test('reads the MTP layer count', () => {
    const bytes = gguf([
      arch('qwen35'),
      { key: 'general.tags', type: VT.ARRAY, value: ['image-text-to-text'] },
      { key: 'qwen35.block_count', type: VT.UINT32, value: 25 },
      { key: 'qwen35.context_length', type: VT.UINT64, value: 262144 },
      { key: 'qwen35.nextn_predict_layers', type: VT.UINT32, value: 1 },
      { key: 'tokenizer.ggml.model', type: VT.STRING, value: 'gpt2' },
    ]);
    expect(parseHeader(bytes)).toEqual({ architecture: 'qwen35', mtpLayers: 1 });
  });

  test('keeps the architecture when the header is cut off mid-value', () => {
    const full = gguf([
      arch('gemma4'),
      { key: 'general.name', type: VT.STRING, value: 'a fairly long model name' },
    ]);
    expect(parseHeader(full.subarray(0, full.length - 10))).toEqual({
      architecture: 'gemma4',
      mtpLayers: 0,
    });
  });

  test('stops at the tokenizer without needing its arrays', () => {
    const bytes = gguf(
      [
        arch('llama'),
        { key: 'tokenizer.ggml.model', type: VT.STRING, value: 'llama' },
      ],
      // The real vocabulary arrays run far past the read window.
      40,
    );
    expect(parseHeader(bytes)).toEqual({ architecture: 'llama', mtpLayers: 0 });
  });

  test('rejects files that are not GGUF', () => {
    const notGguf = gguf([arch('llama')]);
    notGguf[0] = 0x50;
    expect(parseHeader(notGguf)).toEqual({ architecture: null, mtpLayers: 0 });
    expect(parseHeader(new Uint8Array(8))).toEqual({ architecture: null, mtpLayers: 0 });
  });
});

describe('isSupportedTextArch', () => {
  // A stale list would make the app refuse models the engine can load.
  // `npm run setup-native` (or a plain install) regenerates it.
  test('the architecture list was generated from the installed llama.rn', () => {
    expect(LLAMA_RN_VERSION).toBe(require('llama.rn/package.json').version);
  });

  test('knows the architectures of the bundled engine', () => {
    for (const a of ['llama', 'qwen35', 'gemma4', 'gemma3n', 'lfm2', 'smollm3', 'phi3']) {
      expect(isSupportedTextArch(a)).toBe(true);
    }
  });

  test('rejects architectures the engine cannot load', () => {
    expect(isSupportedTextArch('not-a-real-arch')).toBe(false);
    expect(isSupportedTextArch('sdxl')).toBe(false);
  });
});
