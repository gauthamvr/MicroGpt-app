// store/useGenSettingsSlice.ts
//
// Generation + runtime settings persisted across app cold starts.
//
// Previously these lived in React useState inside app/(root)/(tabs)/home.tsx
// which meant every field was reset on app restart. Users asked for the
// settings to persist so every chat (and every character activation) follows
// the same configuration without re-setting them each session.

import { Platform } from 'react-native';

/**
 * Controls what happens when the user activates a character before they've
 * sent their first message.
 *
 *  - 'scripted' — if the character has a hand-written first_message (Chub
 *                 / Character Card V2 field), seed it as an assistant turn
 *                 and KV-cache the prompt. If there's no first_message, the
 *                 model generates a short in-scene greeting instead. This
 *                 matches the SillyTavern "first_mes as fake assistant
 *                 turn" default.
 *  - 'llm'      — always let the model generate the opening message, even
 *                 when the card ships a scripted first_message. The scripted
 *                 text is still added to the system context so the model
 *                 can riff off it, but the visible opener is a fresh
 *                 generation. Useful when the user finds the scripted
 *                 greeting stale or wants a new scene each activation.
 *  - 'off'      — no auto-greeting. Cheap cache-warm only. User starts
 *                 with an empty chat and sends the first message
 *                 themselves.
 */
export type CharacterGreetingMode = 'scripted' | 'llm' | 'off';

/**
 * Hardware acceleration mode for inference.
 *
 *  - 'auto' — detect the best available backend automatically:
 *             NPU (Hexagon HTP) → GPU (Adreno OpenCL) → CPU.
 *  - 'cpu'  — force CPU-only inference. Safest, works everywhere.
 *  - 'gpu'  — use Adreno GPU via OpenCL. Only supports certain quant types
 *             reliably (Q4_0, Q6_K). Falls back to CPU if incompatible.
 *  - 'npu'  — use Qualcomm Hexagon HTP (NPU). Requires a Snapdragon SoC
 *             with HTP support. Falls back to GPU or CPU if unavailable.
 */
export type HardwareAccelMode = 'auto' | 'cpu' | 'gpu' | 'npu';

export type GenSettings = {
  contextLength: number;
  temperature: number;
  topP: number;
  webContextChars: number;
  autocloseWebView: boolean;
  enableThinking: boolean;
  hardwareAcceleration: HardwareAccelMode;
  characterGreeting: CharacterGreetingMode;
  /** Combo mode image generation settings */
  comboImageSteps: number;
  comboImageCfgScale: number;
  comboImageSize: number;
  comboImageNegativePrompt: string;
  /**
   * Auto-load the last-used model on app launch.
   *
   * Default OFF as a safety measure: a buggy GGUF (e.g. quant the runtime
   * crashes on, corrupt download) used to crash the app on every launch
   * with no way to stop it because the autoload re-fired before the user
   * could open settings. Letting the user opt in is safer than betting on
   * every model loading cleanly.
   */
  autoLoadLastModel: boolean;
  /**
   * In combo mode, when an image has just been generated and the loaded
   * LLM is vision-capable (mmproj loaded), feed that image into the very
   * next user turn as a multipart image_url so the model can actually
   * "see" what it just produced. Default ON. Cost: one extra CLIP
   * encoder pass on the post-generation turn only — the image is
   * cleared after one use so it never re-encodes on subsequent turns.
   */
  feedGeneratedImageToVision: boolean;
  /**
   * Use MTP speculative decoding on models that carry multi-token-
   * prediction layers (e.g. the Qwen3.5 "MTP" builds). Read when a model
   * loads. Default OFF: on CPU it measured about 6x slower than plain
   * decoding (Qwen3.5-0.8B-MTP, x86_64 emulator, llama.rn 0.12.9) and it
   * reprocesses the prompt on every turn. Not measured on GPU or NPU.
   */
  speculativeDecoding: boolean;
};

export interface GenSettingsSlice {
  genSettings: GenSettings;
  setGenSettings: (next: GenSettings | ((prev: GenSettings) => GenSettings)) => void;
}

/**
 * Defaults. Hardware acceleration defaults to 'auto' which will detect the
 * best available backend: NPU (Hexagon HTP) → GPU (Adreno OpenCL) → CPU.
 * On iOS, Metal GPU is always used via n_gpu_layers (auto resolves to 'gpu').
 */
export const defaultGenSettings: GenSettings = {
  contextLength: 2048,
  temperature: 0.7,
  topP: 0.95,
  webContextChars: 300,
  autocloseWebView: true,
  // Default OFF for fast roleplay responses. User can enable for Qwen3 /
  // DeepSeek-R1 / GLM-4.5 / Gemma 4 style reasoning models.
  enableThinking: false,
  hardwareAcceleration: 'auto',
  characterGreeting: 'scripted',
  comboImageSteps: 12,
  comboImageCfgScale: 7.5,
  comboImageSize: 256,
  comboImageNegativePrompt: 'blurry, low quality, distorted, deformed, ugly, bad anatomy',
  autoLoadLastModel: false,
  feedGeneratedImageToVision: true,
  speculativeDecoding: false,
};

const createGenSettingsSlice = (set: any, _get: any): GenSettingsSlice => ({
  genSettings: { ...defaultGenSettings },
  setGenSettings: (next) => {
    set((state: any) => {
      const prev = state.genSettings ?? defaultGenSettings;
      const updated = typeof next === 'function' ? (next as any)(prev) : next;
      return { genSettings: { ...updated } };
    });
  },
});

export default createGenSettingsSlice;
