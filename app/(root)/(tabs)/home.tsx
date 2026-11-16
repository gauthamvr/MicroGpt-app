// app/(root)/(tabs)/home.tsx
import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  Fragment,
} from 'react';
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  useColorScheme,
  NativeSyntheticEvent,
  NativeScrollEvent,
  ColorSchemeName,
  TextInputContentSizeChangeEventData,
  Animated,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  UIManager,
  KeyboardEvent,
  AppState,
  AppStateStatus,
  Image,
  Pressable,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';

import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Entypo from '@expo/vector-icons/Entypo';

import { useStore, formatBytes, formatEta, isImageGenModel, parseFileSizeString } from '@/store';
import DownloadModel from '@/components/DownloadModel';
import ImageGenerationView from '@/components/ImageGenerationView';
import ModelSettingsModal from '@/components/ModelSettingsModal';
import { initLlama, getBackendDevicesInfo, LlamaContext, RNLlamaOAICompatibleMessage, RNLlamaMessagePart } from 'llama.rn';
import ReactNativeBlobUtil from 'react-native-blob-util';
import * as ImageGenService from '@/lib/image-gen-service';
import { getModelsDir, getLegacyModelsDir } from '@/lib/storage-paths';
import { npuCoordinator } from '@/lib/npu-coordinator';
import { validateGgufFile, detectGgufModelType, isSupportedTextArch } from '@/lib/gguf-detect';
import { estimateTokens, selectHistoryWindow } from '@/lib/chat-context';
import { createComboStreamProcessor, ComboStreamProcessor, ComboImageSettings } from '@/lib/combo-chat-handler';
import { checkChatText, CHAT_BLOCKED_REPLY, CHAT_CONTENT_RULE } from '@/lib/content-safety';
import { promptReport } from '@/lib/content-report';
import * as ImagePicker from 'expo-image-picker';

import type { HardwareAccelMode, Model } from '@/store';

/**
 * Performance params layered on top of the minimal init set. These are
 * the safe wins the reference project (off-grid-mobile-ai) ships and
 * we explicitly skipped the dangerous ones — flash_attn_type and
 * cache_type_k/v had known OpenCL crashes (issue #229) that motivated
 * the original "minimal params" decision in 497c2bd.
 *
 *  - n_threads: 4 perf cores. Over-threading onto efficiency cores
 *    (e.g. Cortex-A520) hurts on big.LITTLE Snapdragons.
 *  - n_batch / n_ubatch: 512. Faster prompt processing without
 *    materially increasing memory pressure (the KV cache, not the
 *    batch, dominates RAM at our context lengths).
 *  - use_mmap=false for repackable quants (q4_0, iq4_nl). llama.cpp
 *    repacks these at load; mmap interferes with the repack and you
 *    end up with a slow path. mlock paths already bypass mmap, so
 *    this only matters for the paged-fallback configuration.
 */
const REPACKABLE_QUANTS = ['q4_0', 'iq4_nl'];
function shouldDisableMmap(modelPath: string): boolean {
  if (Platform.OS !== 'android') return false;
  const lower = modelPath.toLowerCase();
  return REPACKABLE_QUANTS.some((q) => lower.includes(q));
}
function getPerfParams(modelPath: string): { n_threads: number; n_batch: number; n_ubatch: number; mmapHint: boolean } {
  return {
    n_threads: 4,
    n_batch: 512,
    n_ubatch: 512,
    mmapHint: !shouldDisableMmap(modelPath),
  };
}

/**
 * MTP speculative decoding, for GGUFs that carry multi-token-prediction
 * (NextN) layers such as unsloth's Qwen3.5 "MTP" builds. The model drafts
 * a few tokens ahead with its own prediction head and keeps the ones the
 * full model agrees with, so output is unchanged and only speed differs.
 * It has to be passed to initLlama (hybrid models allocate their rollback
 * state at load) and again on every completion.
 */
const MTP_SPECULATIVE = { type: 'draft-mtp', n_max: 3 } as const;

/**
 * Resolve the user's hardware acceleration preference into an actual backend
 * by probing what's available on this device via llama.rn's backend API.
 *
 * Priority chain for 'auto': NPU (Hexagon HTP) → GPU (OpenCL) → CPU.
 *
 * Returns: { mode, devices, nGpuLayers, deviceLabel, warning? }
 */
async function resolveHardwareBackend(
  preference: HardwareAccelMode,
  modelName: string,
  isAndroid: boolean,
): Promise<{
  mode: 'cpu' | 'gpu' | 'npu';
  devices: string[] | undefined;
  nGpuLayers: number;
  deviceLabel: string;
  warning: string | null;
}> {
  // iOS always uses Metal — the devices param isn't needed
  if (!isAndroid) {
    return {
      mode: 'gpu',
      devices: undefined,
      nGpuLayers: 99,
      deviceLabel: 'Metal GPU',
      warning: null,
    };
  }

  // Probe available backends on this Android device
  let backendDevices: Array<{ backend: string; type: string; deviceName: string; maxMemorySize: number }> = [];
  try {
    backendDevices = await getBackendDevicesInfo();
  } catch (e) {
    if (__DEV__) console.warn('[resolveHardwareBackend] getBackendDevicesInfo failed:', e);
  }

  const htpDevices = backendDevices.filter(d => d.deviceName.startsWith('HTP'));
  const gpuDevices = backendDevices.filter(
    d => d.type === 'GPU' || d.backend.toLowerCase().includes('opencl') || d.deviceName.toLowerCase().includes('adreno'),
  );
  const hasNpu = htpDevices.length > 0;
  const hasGpu = gpuDevices.length > 0;

  if (__DEV__) {
    console.log('[resolveHardwareBackend] backends:', JSON.stringify(backendDevices));
    console.log(`[resolveHardwareBackend] hasNpu=${hasNpu}, hasGpu=${hasGpu}, preference=${preference}`);
  }

  // Resolve 'auto' into a concrete mode
  let resolved: 'cpu' | 'gpu' | 'npu' = 'cpu';
  if (preference === 'auto') {
    if (hasNpu) resolved = 'npu';
    else if (hasGpu) resolved = 'gpu';
    else resolved = 'cpu';
  } else {
    resolved = preference;
  }

  // NPU path — use Hexagon HTP devices
  if (resolved === 'npu') {
    if (!hasNpu) {
      // Fallback: NPU requested but not available → try GPU → CPU.
      // GPU compatibility isn't pre-screened by quant — let initLlama try
      // and the catch block in doLoadModel falls back to CPU on real failure.
      if (hasGpu) {
        return {
          mode: 'gpu',
          devices: undefined,
          nGpuLayers: 99,
          deviceLabel: gpuDevices[0]?.deviceName || 'GPU',
          warning: 'NPU not available on this device — using GPU instead.',
        };
      }
      return {
        mode: 'cpu',
        devices: undefined,
        nGpuLayers: 0,
        deviceLabel: 'CPU',
        warning: 'NPU not available on this device — using CPU.',
      };
    }
    return {
      mode: 'npu',
      devices: ['HTP*'],
      nGpuLayers: 99,
      deviceLabel: htpDevices[0]?.deviceName || 'Hexagon NPU',
      warning: null,
    };
  }

  // GPU path — use Adreno OpenCL. No pre-flight quant block — let
  // initLlama attempt the load and rely on the runtime fallback in
  // doLoadModel if it crashes.
  if (resolved === 'gpu') {
    if (!hasGpu) {
      return {
        mode: 'cpu',
        devices: undefined,
        nGpuLayers: 0,
        deviceLabel: 'CPU',
        warning: 'GPU not available on this device — using CPU.',
      };
    }
    return {
      mode: 'gpu',
      devices: undefined,
      nGpuLayers: 99,
      deviceLabel: gpuDevices[0]?.deviceName || 'GPU',
      warning: null,
    };
  }

  // CPU path
  return {
    mode: 'cpu',
    devices: undefined,
    nGpuLayers: 0,
    deviceLabel: 'CPU',
    warning: null,
  };
}

import ChatSessionsList from '@/components/ChatHistoryModal';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/* ──────────────────────────────────────────────────────────────────
   HELPERS & CONSTANTS
   ──────────────────────────────────────────────────────────────── */
const STANDARD_STOP_WORDS = [
  '</s>',
  '<|end|>',
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|im_end|>',
  '<|EOT|>',
  '<|END_OF_TURN_TOKEN|>',
  '<|end_of_turn|>',
  '<|endoftext|>',
  '<|end_of_sentence|>',
  '<eos>',
  '<end_of_turn>',
  '<|return|>',          // GPT-OSS / Harmony return token
];

// Strip stray Harmony / GPT-OSS framing tokens that sometimes leak into the
// visible text (channel routing markers, role prefixes, etc.). The actual
// channel CONTENT is handled by parseThinkTags below — this only removes
// orphan tokens that don't form a complete block. NOTE: this does NOT strip
// the Gemma 4 asymmetric `<|channel>` / `<channel|>` tags — those are kept
// so parseThinkTags can split them into thinking/text segments.
function stripHarmonyTokens(t: string) {
  return t
    .replace(/<\|start\|>(?:assistant|user|system|developer)?/gi, '')
    .replace(/<\|message\|>/gi, '')
    .replace(/<\|return\|>/gi, '')
    .replace(/<\|constrain\|>[^<]*?(?=<\|)/gi, '')
    .replace(/<\|channel\|>final\b/gi, '');
}

// Strip the `<RESPONSE>...</RESPONSE>` wrapper that Qwen3-RPG and some
// fine-tuned roleplay models put around their actual reply, plus the
// leading "Assistant:" / "AI:" role prefix that often follows. Both are
// chat-template artefacts the user should never see — but we keep the
// CONTENT inside the wrapper. Streaming-safe: if only the opening
// `<RESPONSE>` has arrived yet, drop the open tag and let the rest
// flow; the closing `</RESPONSE>` gets stripped when it lands.
function stripResponseWrapper(t: string) {
  return t
    // Drop the open / close tags wherever they appear (case-insensitive)
    .replace(/<\/?RESPONSE>/gi, '')
    // Drop a leading role prefix like "Assistant:" / "AI:" that some
    // roleplay templates emit at the start of the response. Only when
    // it sits at the start of the whole reply or right after a newline.
    .replace(/(^|\n)\s*(?:assistant|ai|model)\s*:\s*/gi, '$1');
}

// Some chat templates (notably Qwen3-RPG variants) ship a `<thinking>`
// block whose OPENING tag is part of the system / template prefix and
// gets consumed before our visible-text window starts — we only ever
// see the closing `</thinking>` come through. Without this fixup the
// preamble (planning / persona-priming text) leaks into the visible
// reply.
//
// Heuristic: if a known close tag appears WITHOUT its matching open tag
// earlier in the buffer, prepend a synthetic open at the very start so
// the regular paired-tag parser handles everything before the close as
// thinking. We only do this for the first stray close — extras are
// safe noise the parser drops.
function normalizeStrayCloseTags(message: string): string {
  const lower = message.toLowerCase();
  for (const openTag of THINK_OPEN_TAGS) {
    const closeTag = THINK_CLOSE_MAP[openTag];
    if (!closeTag) continue;
    const closeIdx = lower.indexOf(closeTag.toLowerCase());
    if (closeIdx === -1) continue;
    const openIdx = lower.indexOf(openTag.toLowerCase());
    if (openIdx === -1 || openIdx > closeIdx) {
      return openTag + message;
    }
  }
  return message;
}

function partialCleanup(t: string) {
  return stripResponseWrapper(stripHarmonyTokens(
    t
      .normalize('NFKC')
      .replace(/<[^>]*(?:end_of_sentence|end▁of▁sentence)[^>]*>/gi, '')
  ));
}
function finalCleanup(t: string) {
  let txt = stripResponseWrapper(stripHarmonyTokens(
    t
      .normalize('NFKC')
      .replace(/<[^>]*(?:end_of_sentence|end▁of▁sentence)[^>]*>/gi, '')
  )).trim();
  let again = true;
  while (again) {
    again = false;
    for (const sw of STANDARD_STOP_WORDS) {
      const tr = txt.trimEnd();
      if (tr.endsWith(sw)) {
        txt = tr.slice(0, -sw.length).trimEnd();
        again = true;
        break;
      }
    }
  }
  return txt;
}

/**
 * Parse thinking/reasoning blocks from model output.
 * Supports multiple formats:
 *   <think>...</think>                              (DeepSeek, Qwen)
 *   <start_of_thought>...<end_of_thought>           (Gemma older)
 *   <|thinking|>...<|/thinking|>                    (some Llama variants)
 *   <|channel>...<channel|>                         (Gemma 4 — ASYMMETRIC tags!)
 *   <|channel|>analysis<|message|>...<|end|>        (GPT-OSS / Harmony)
 *   <|channel|>final<|message|>...                  (GPT-OSS / Harmony final)
 */
type ThinkSeg = { type: 'think' | 'text'; content: string };

// Simple paired tags. `<thinking>...</thinking>` (no pipes) is what
// Qwen3-RPG-style roleplay fine-tunes use; the others cover DeepSeek,
// older Gemma, and Llama-thinking variants.
const THINK_OPEN_TAGS = ['<think>', '<thinking>', '<start_of_thought>', '<|thinking|>'];
const THINK_CLOSE_MAP: Record<string, string> = {
  '<think>': '</think>',
  '<thinking>': '</thinking>',
  '<start_of_thought>': '<end_of_thought>',
  '<|thinking|>': '<|/thinking|>',
};

// Gemma 4 asymmetric channel block. IMPORTANT: these tags are NOT symmetric.
//   Open:  <|channel>   (pipe goes right after the `<`)
//   Close: <channel|>   (pipe goes right before the `>`)
// The content between is the "thinking" block. Everything after the close
// is the visible response text. There is no Harmony-style <|message|>.
const GEMMA4_BLOCK_RE = /<\|channel>([\s\S]*?)<channel\|>/gi;
const GEMMA4_OPEN_RE = /<\|channel>/i;
const GEMMA4_CLOSE = '<channel|>';

// Harmony (GPT-OSS) channel blocks — symmetric `<|channel|>` markers.
const HARMONY_ANALYSIS_RE =
  /<\|channel\|>\s*analysis(?:<\|constrain\|>[^<]*)?<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|start\|>|<\|return\|>|<\|channel\|>|$)/gi;
const HARMONY_FINAL_RE =
  /<\|channel\|>\s*final(?:<\|constrain\|>[^<]*)?<\|message\|>([\s\S]*?)(?=<\|end\|>|<\|start\|>|<\|return\|>|<\|channel\|>|$)/gi;

function parseThinkTags(message: string): ThinkSeg[] {
  // Pre-pass: if a thinking close tag appears with no matching open
  // (Qwen3-RPG and similar fine-tunes that bake the open into the
  // chat template prefix), prepend a synthetic open so the rest of
  // the parser routes the preamble into the thinking section
  // instead of leaking it into the visible reply.
  message = normalizeStrayCloseTags(message);

  // Step 1: Gemma 4 asymmetric channel format.
  // Detected by the presence of `<|channel>` (without a trailing pipe before
  // the `>`) which is distinct from Harmony's `<|channel|>`.
  if (GEMMA4_OPEN_RE.test(message) && !/<\|channel\|>/i.test(message)) {
    const segs: ThinkSeg[] = [];
    let rest = message;
    while (rest.length > 0) {
      const openMatch = rest.match(GEMMA4_OPEN_RE);
      if (!openMatch || openMatch.index === undefined) {
        if (rest) segs.push({ type: 'text', content: rest });
        break;
      }
      // Emit anything before the open tag as visible text
      if (openMatch.index > 0) {
        segs.push({ type: 'text', content: rest.slice(0, openMatch.index) });
      }
      const afterOpen = openMatch.index + openMatch[0].length;
      const closeIdx = rest.indexOf(GEMMA4_CLOSE, afterOpen);
      if (closeIdx === -1) {
        // Still streaming — show the in-progress thought as thinking
        const partial = rest.slice(afterOpen).replace(/^\s*\n/, '');
        if (partial) segs.push({ type: 'think', content: partial });
        break;
      }
      const thinkContent = rest.slice(afterOpen, closeIdx).replace(/^\s*\n/, '').trimEnd();
      if (thinkContent) segs.push({ type: 'think', content: thinkContent });
      rest = rest.slice(closeIdx + GEMMA4_CLOSE.length);
    }
    return segs;
  }

  // Step 2: Harmony (GPT-OSS) symmetric channel format.
  if (/<\|channel\|>/i.test(message)) {
    const segs: ThinkSeg[] = [];
    type Match = { start: number; end: number; type: 'think' | 'text'; content: string };
    const matches: Match[] = [];

    HARMONY_ANALYSIS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HARMONY_ANALYSIS_RE.exec(message)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, type: 'think', content: m[1] });
    }
    HARMONY_FINAL_RE.lastIndex = 0;
    while ((m = HARMONY_FINAL_RE.exec(message)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, type: 'text', content: m[1] });
    }
    matches.sort((a, b) => a.start - b.start);

    // Handle the still-streaming case: an open `<|channel|>analysis<|message|>`
    // with no close yet. Show the unfinished content as thinking.
    const lastChannelIdx = message.toLowerCase().lastIndexOf('<|channel|>');
    if (lastChannelIdx !== -1 && (matches.length === 0 || lastChannelIdx >= matches[matches.length - 1].end)) {
      const tail = message.slice(lastChannelIdx);
      const isAnalysis = /^<\|channel\|>\s*analysis/i.test(tail);
      const isFinal = /^<\|channel\|>\s*final/i.test(tail);
      const msgIdx = tail.toLowerCase().indexOf('<|message|>');
      if ((isAnalysis || isFinal) && msgIdx !== -1) {
        const partial = tail.slice(msgIdx + '<|message|>'.length);
        matches.push({
          start: lastChannelIdx,
          end: message.length,
          type: isFinal ? 'text' : 'think',
          content: partial,
        });
      }
    }

    if (matches.length > 0) {
      // Anything BEFORE the first channel marker — usually empty, but
      // sometimes models leak prose. Show it as plain text.
      const preface = message.slice(0, matches[0].start).replace(/<\|[^|]*\|>/g, '').trim();
      if (preface) segs.push({ type: 'text', content: preface });
      for (const match of matches) {
        const content = match.content
          .replace(/<\|end\|>/gi, '')
          .replace(/<\|return\|>/gi, '')
          .trimEnd();
        if (content) segs.push({ type: match.type, content });
      }
      return segs;
    }
    // Fall through if we matched `<|channel|>` but couldn't parse a block
  }

  // Legacy paired-tag parser for <think>, <start_of_thought>, <|thinking|>
  const segs: ThinkSeg[] = [];
  let rest = message;
  while (rest.length > 0) {
    // Find the earliest opening tag
    let earliest = -1;
    let matchedOpen = '';
    for (const tag of THINK_OPEN_TAGS) {
      const idx = rest.toLowerCase().indexOf(tag.toLowerCase());
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        matchedOpen = tag;
      }
    }
    if (earliest === -1) {
      if (rest) segs.push({ type: 'text', content: rest });
      break;
    }
    if (earliest > 0) {
      segs.push({ type: 'text', content: rest.slice(0, earliest) });
    }
    const closeTag = THINK_CLOSE_MAP[matchedOpen];
    const afterOpen = earliest + matchedOpen.length;
    const closeIdx = rest.toLowerCase().indexOf(closeTag.toLowerCase(), afterOpen);
    if (closeIdx === -1) {
      // Unclosed thinking block (still streaming) — treat rest as thinking
      segs.push({ type: 'think', content: rest.slice(afterOpen) });
      break;
    }
    segs.push({ type: 'think', content: rest.slice(afterOpen, closeIdx) });
    rest = rest.slice(closeIdx + closeTag.length);
  }
  return segs;
}

/**
 * Parse roleplay-style text into styled spans.
 * Recognizes:
 *   *action text*       → italic, dimmed (physical actions, body language)
 *   **bold text**       → bold
 *   "spoken dialogue"   → kept as-is, primary text color
 *
 * Stream-safe: when an opening `*` has no closing `*` yet (still streaming),
 * everything after the opener is rendered as italic immediately so the styling
 * doesn't snap from plain → italic when the closer finally arrives.
 */
type RoleplaySpan = { type: 'text' | 'action' | 'bold'; content: string };

function parseRoleplayText(text: string): RoleplaySpan[] {
  if (!text) return [];
  const spans: RoleplaySpan[] = [];
  let i = 0;
  let buf = '';

  const flushText = () => {
    if (buf) {
      spans.push({ type: 'text', content: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    // **bold**
    if (text[i] === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      if (close !== -1) {
        flushText();
        spans.push({ type: 'bold', content: text.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
      // Unclosed bold (still streaming) — render rest as bold optimistically
      flushText();
      spans.push({ type: 'bold', content: text.slice(i + 2) });
      return spans;
    }

    // *action* — must be a single asterisk (not part of **)
    if (text[i] === '*') {
      // Find the next single `*` that isn't followed by another `*`
      let close = -1;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '*' && text[j + 1] !== '*') {
          close = j;
          break;
        }
        if (text[j] === '*' && text[j + 1] === '*') {
          // Hit a bold marker — back off, this asterisk is unclosed
          break;
        }
        j++;
      }
      if (close !== -1 && close > i + 1) {
        const inner = text.slice(i + 1, close);
        flushText();
        spans.push({ type: 'action', content: inner });
        i = close + 1;
        continue;
      }
      // Unclosed action (still streaming) — render rest as italic optimistically.
      // This is the key fix: instead of leaving the partial as plain text and
      // snapping to italic later, commit to italic right away. The asterisks
      // stay visible and the closing `*` will arrive in a later frame.
      flushText();
      spans.push({ type: 'action', content: text.slice(i + 1) });
      return spans;
    }

    buf += text[i];
    i++;
  }

  flushText();
  return spans;
}

/**
 * Build the system prompt for a roleplay character. Honors per-card
 * overrides from Character Card V2 fields when present:
 *   - systemPrompt: replaces the hardcoded rules block
 *   - scenario: injected as a "# Scenario" block
 *   - description: "# Character" block (persona traits)
 *   - conversationStyle: "# Example Dialog" block (only if non-empty)
 *
 * Keeps the structure lean for small local models (1-7B), following
 * Virt-io / Sukino SillyTavern preset guidance: short rules, examples
 * as completion-style few-shot, personality restated by the post-history
 * reminder (which is added separately just before generation).
 */
function buildCharacterSystemPrompt(
  c: {
    name: string;
    description: string;
    conversationStyle: string;
    scenario?: string;
    systemPrompt?: string;
  },
  options?: { comboMode?: boolean; imageModelLoaded?: boolean },
): string {
  const blocks: string[] = [];
  blocks.push(
    `You ARE ${c.name}. This is a roleplay — fully embody this character.`,
  );
  if (c.description?.trim()) {
    blocks.push(`# Character\n${c.description.trim()}`);
  }
  if (c.scenario?.trim()) {
    blocks.push(`# Scenario\n${c.scenario.trim()}`);
  }
  if (c.conversationStyle?.trim()) {
    blocks.push(`# Example Dialog\n${c.conversationStyle.trim()}`);
  }
  if (c.systemPrompt?.trim()) {
    // Creator-supplied override replaces the hardcoded rules entirely
    blocks.push(c.systemPrompt.trim());
  } else {
    blocks.push(
      `# Rules\n` +
        `- Stay in character at all times. Never break the fourth wall.\n` +
        `- Never say you are an AI, language model, or assistant.\n` +
        `- Match the character's personality fully.\n` +
        `- Respond as the character would naturally respond.\n` +
        `- Use *actions in asterisks* for physical gestures when it fits.\n` +
        `- Keep replies in-scene and immersive.`,
    );
  }

  // Combo mode: instruct the model it can "send photos" via [IMG: ...] tags
  if (options?.comboMode && options?.imageModelLoaded) {
    blocks.push(
      `# Photo Capability — IMPORTANT\n` +
        `You have the ability to send photos and images! You MUST use this when the user asks for a photo, selfie, picture, or image.\n` +
        `To send a photo, output this exact tag format: [IMG: detailed visual description]\n\n` +
        `Examples:\n` +
        `- User says "send me a selfie" → You reply: *smiles and takes a selfie* [IMG: close-up selfie of a young woman with brown hair, warm smile, soft lighting, casual outfit]\n` +
        `- User says "show me a picture of a sunset" → You reply: Here you go! [IMG: beautiful sunset over the ocean, orange and purple sky, calm waves, golden hour lighting]\n\n` +
        `Rules:\n` +
        `- ALWAYS use [IMG: ...] when the user asks for any photo, picture, selfie, or image\n` +
        `- NEVER say you cannot send photos or generate images — you CAN\n` +
        `- The description inside [IMG: ...] must be detailed: subject, pose/action, lighting, style, mood\n` +
        `- People in photos are always fully clothed in everyday outfits; never describe nudity, underwear, swimwear or suggestive poses\n` +
        `- You can include conversational text before and/or after the [IMG: ...] tag`,
    );
  }

  blocks.push(CHAT_CONTENT_RULE);
  return blocks.join('\n\n');
}

type ChatMessage = {
  id: string;
  sender: 'User' | 'Model';
  message: string;
  isStreaming?: boolean;
  imageUri?: string;
  isGeneratingImage?: boolean;
  imagePrompt?: string;
};

type LoadModelOptions = {
  /** Keep the text model off the Hexagon NPU (image generation owns it). */
  forceNonNpu?: boolean;
  /** Reloading the model the chat was already using: keep the conversation. */
  keepSession?: boolean;
};

/* tiny typing dots, optionally with a small "{name} is typing" label */
const TypingIndicator = ({
  anim,
  label,
}: {
  anim: Animated.Value;
  label?: string;
}) => (
  <Animated.View
    style={{
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 4,
      opacity: anim,
    }}
  >
    <View className="w-2 h-2 bg-gray-400 rounded-full mr-1" />
    <View className="w-2 h-2 bg-gray-400 rounded-full mr-1" />
    <View className="w-2 h-2 bg-gray-400 rounded-full" />
    {label ? (
      <Text
        style={{
          marginLeft: 8,
          fontSize: 11,
          color: '#888888',
          fontStyle: 'italic',
        }}
      >
        {label}
      </Text>
    ) : null}
  </Animated.View>
);

/* ──────────────────────────────────────────────────────────────────
   Memoized chat-row component
   ──────────────────────────────────────────────────────────────────
   Why this lives outside <Home>: previously renderMsg was defined
   inline as a closure, which gave FlatList a new renderItem reference
   on every parent render. Combined with the fact that each row re-ran
   the expensive parseThinkTags / parseRoleplayText text-parsing work,
   streaming a single token forced the visible list to fully re-render
   — the VirtualizedList slow-update warning surfaced this clearly.

   Pulling the row into a standalone React.memo with a narrow
   comparator fixes it: only the row whose message (or isStreaming
   flag) actually changed re-renders. The other rows stay cached.
   ──────────────────────────────────────────────────────────────── */

type ChatMessageRowProps = {
  item: ChatMessage;
  // Web-preview state — passed as props so memo can skip when it's
  // not actually changing for this particular row.
  showPreview: boolean;
  previewTimedOut: boolean;
  webQuery: string | null;
  webKeyVal: number;
  injectedJS: string;
  onWebViewMessage: (data: string) => void;
  // Appearance
  cs: 'light' | 'dark' | 'unspecified' | null | undefined;
  // Typing indicator
  typingAnim: Animated.Value;
  characterName: string | null;
  // Combo image gen progress
  imageProgress: { step: number; total: number } | null;
};

const ChatMessageRow: React.FC<ChatMessageRowProps> = ({
  item,
  showPreview,
  previewTimedOut,
  webQuery,
  webKeyVal,
  injectedJS,
  onWebViewMessage,
  cs,
  typingAnim,
  characterName,
  imageProgress,
}) => {
  // Long-press on a bubble → system share sheet, which on Android
  // gives Copy / Share-with-app (Gmail, Keep, Messages, etc.) for
  // free. No extra native module needed, unlike expo-clipboard.
  const shareMessage = async () => {
    const text = (item.message || '').trim();
    if (!text) return;
    try {
      await Share.share({ message: text });
    } catch {}
  };
  // Long-press on an image inside a bubble → save it to the public
  // Downloads/MicroGPT folder + media scanner, separate from the text
  // share sheet above.
  const saveBubbleImage = async (uri: string) => {
    try {
      await ImageGenService.saveImageToGallery(uri);
      themedAlert('Saved', 'Image saved to gallery and Downloads/MicroGPT/');
    } catch (e: any) {
      themedAlert('Save failed', e?.message ?? 'Could not save image.');
    }
  };
  if (item.sender === 'User') {
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={shareMessage}
        delayLongPress={350}
        className="self-end p-3 m-2 max-w-2/3 rounded-2xl bg-theme-light-input-background dark:bg-theme-dark-input-background"
      >
        {item.imageUri && (
          <Pressable
            onLongPress={() => saveBubbleImage(item.imageUri!)}
            delayLongPress={400}
          >
            <Image
              source={{ uri: item.imageUri }}
              style={{ width: 180, height: 180, borderRadius: 12, marginBottom: 6 }}
              resizeMode="cover"
            />
          </Pressable>
        )}
        {item.message && item.message !== '(image)' && (
          <Text className="text-lg text-theme-light-text-primary dark:text-theme-dark-text-primary">
            {item.message}
          </Text>
        )}
        {showPreview && (
          <>
            {previewTimedOut ? (
              <Text className="text-xs text-red-400 mt-2">
                Check your internet connection.
              </Text>
            ) : (
              <View
                className="mt-2 rounded-lg overflow-hidden"
                style={{ width: 150, height: 150 }}
              >
                <WebView
                  key={webKeyVal}
                  source={{
                    uri: `https://www.google.com/search?q=${encodeURIComponent(
                      webQuery ?? ''
                    )}`,
                  }}
                  injectedJavaScript={injectedJS}
                  onMessage={(e: WebViewMessageEvent) =>
                    onWebViewMessage(e.nativeEvent.data)
                  }
                  javaScriptEnabled
                  domStorageEnabled
                  style={{ flex: 1 }}
                />
              </View>
            )}
          </>
        )}
      </TouchableOpacity>
    );
  }

  // Assistant message. The parsed segments (think/text + bold/action
  // spans) are the expensive part — recomputed here only when this
  // specific row re-renders, which (thanks to React.memo below) only
  // happens when item.message actually changes.
  //
  // While streaming, strip the trailing incomplete word so partial
  // words/tags don't flicker into view before they're complete. This
  // matches the "buffer until whitespace" behavior from the web version.
  const rawMessage = item.message || '';
  const visibleMessage = item.isStreaming
    ? rawMessage.replace(/\S+$/, '')
    : rawMessage;
  const segs = parseThinkTags(visibleMessage);

  return (
    <TouchableOpacity
      activeOpacity={0.95}
      onLongPress={shareMessage}
      delayLongPress={350}
      className="self-start p-3 m-2 w-full rounded-xl bg-transparent"
    >
      {item.isGeneratingImage && (
        <View style={{ width: 240, height: 80, borderRadius: 12, marginBottom: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: cs === 'dark' ? '#1A1A2E' : '#F0F0FF' }}>
          <ActivityIndicator size="small" color={cs === 'dark' ? '#8B8BFF' : '#5C5CFF'} />
          <Text style={{ color: cs === 'dark' ? '#9BA1A6' : '#6B7280', fontSize: 12, marginTop: 6 }}>
            Generating image...
          </Text>
          {imageProgress && imageProgress.total > 0 && (
            <View style={{ width: 180, height: 4, backgroundColor: cs === 'dark' ? '#2A2A3E' : '#D0D0E0', borderRadius: 2, marginTop: 6, overflow: 'hidden' }}>
              <View style={{ height: '100%', width: `${Math.min(100, Math.round((imageProgress.step / imageProgress.total) * 100))}%`, backgroundColor: '#8B5CF6', borderRadius: 2 }} />
            </View>
          )}
        </View>
      )}
      {item.imageUri && (
        <Pressable
          onLongPress={() => saveBubbleImage(item.imageUri!)}
          delayLongPress={400}
        >
          <Image
            source={{ uri: item.imageUri }}
            style={{ width: 240, height: 240, borderRadius: 12, marginBottom: 8 }}
            resizeMode="cover"
          />
        </Pressable>
      )}
      {segs.map((s, i) =>
        s.type === 'think' ? (
          <View key={i} className="flex-row my-2">
            <View className="w-1 bg-gray-500 rounded-l-full" />
            <View className="flex-1 ml-2">
              <Text className="italic text-gray-500">{s.content}</Text>
            </View>
          </View>
        ) : (
          <Text
            key={i}
            className="text-lg text-theme-light-text-primary dark:text-theme-dark-text-primary"
          >
            {parseRoleplayText(s.content).map((span, j) => {
              if (span.type === 'action') {
                return (
                  <Text
                    key={j}
                    style={{
                      fontStyle: 'italic',
                      color: cs === 'dark' ? '#A0A8B0' : '#666666',
                    }}
                  >
                    *{span.content}*
                  </Text>
                );
              }
              if (span.type === 'bold') {
                return (
                  <Text key={j} style={{ fontWeight: 'bold' }}>
                    {span.content}
                  </Text>
                );
              }
              return <Text key={j}>{span.content}</Text>;
            })}
          </Text>
        )
      )}
      {!item.isStreaming && !item.isGeneratingImage && (item.imageUri || rawMessage.trim()) ? (
        <TouchableOpacity
          onPress={() =>
            promptReport({
              contentType: item.imageUri ? 'image' : 'chat',
              modelName: useStore.getState().selectedModel?.name,
              prompt: item.imagePrompt,
              contentExcerpt: rawMessage,
            })
          }
          accessibilityLabel="Report this reply"
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginTop: 6, opacity: 0.75 }}
        >
          <Ionicons name="flag-outline" size={13} color={cs === 'dark' ? '#9BA1A6' : '#6B7280'} />
          <Text style={{ marginLeft: 4, fontSize: 12, color: cs === 'dark' ? '#9BA1A6' : '#6B7280' }}>
            Report
          </Text>
        </TouchableOpacity>
      ) : null}
      {item.isStreaming && (
        <TypingIndicator
          anim={typingAnim}
          label={
            // With a character active the roleplay illusion is broken
            // by "thinking" (suggests an assistant / tool-use). Always
            // use "is typing…" for characters, whether we're still in
            // the prefill dead window or tokens have started flowing.
            // In plain-chat mode, fall back to "Thinking…" until the
            // first token arrives, so the user sees something other
            // than three dots on a blank bubble.
            characterName
              ? `${characterName} is typing…`
              : rawMessage
                ? undefined
                : 'Thinking…'
          }
        />
      )}
    </TouchableOpacity>
  );
};

/**
 * Memo comparator — return true to skip re-rendering. We compare:
 *   - item content fields that affect the output (id, message,
 *     isStreaming, imageUri). We intentionally DON'T compare by
 *     reference on `item` because Zustand's updateChatMessage creates
 *     a new array and a new item object on every token.
 *   - externally-sourced state we pass as props. These rarely change
 *     so shallow comparison is fine.
 *
 * The typingAnim Animated.Value has stable identity so it's cheap to
 * compare by reference.
 */
const ChatMessageRowMemo = React.memo(ChatMessageRow, (prev, next) => {
  if (prev.item.id !== next.item.id) return false;
  if (prev.item.message !== next.item.message) return false;
  if (prev.item.isStreaming !== next.item.isStreaming) return false;
  if (prev.item.imageUri !== next.item.imageUri) return false;
  if (prev.item.isGeneratingImage !== next.item.isGeneratingImage) return false;
  if (prev.imageProgress !== next.imageProgress) return false;
  if (prev.item.sender !== next.item.sender) return false;
  if (prev.showPreview !== next.showPreview) return false;
  if (prev.previewTimedOut !== next.previewTimedOut) return false;
  if (prev.webQuery !== next.webQuery) return false;
  if (prev.webKeyVal !== next.webKeyVal) return false;
  if (prev.cs !== next.cs) return false;
  if (prev.characterName !== next.characterName) return false;
  // onWebViewMessage, injectedJS, typingAnim identities are stable
  // per-session, so we don't need to compare them.
  return true;
});

/**
 * Download progress rows, extracted into their own component so the
 * high-frequency downloadProgress / downloadStats / downloadPhase
 * subscriptions don't live at the Home level. During a background
 * download, these fields fire every 500 ms; having Home read them
 * would rerun the whole 3000-line Home body each tick.
 */
const DownloadProgressHeader: React.FC<{ cs: ColorSchemeName }> = ({ cs }) => {
  const activeDownloads = useStore((s) => s.activeDownloads);
  const isDownloading = useStore((s) => s.isDownloading);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const downloadStats = useStore((s) => s.downloadStats);
  const downloadPhase = useStore((s) => s.downloadPhase);
  const cancelDownload = useStore((s) => s.cancelDownload);
  if (!isDownloading) return null;
  return (
    <>
      {Array.from(activeDownloads || []).map((name) => {
        const rawProgress = downloadProgress?.[name] ?? 0;
        const stats = downloadStats?.[name];
        const phase = downloadPhase?.[name];
        const isIndeterminate = rawProgress < 0;
        const isActiveTransfer = !phase || phase === 'downloading' || phase === 'downloading_projector';
        const isPostDownload = !isActiveTransfer;
        const fraction = isIndeterminate ? 0 : Math.max(0, Math.min(1, rawProgress));
        const displayPct = isPostDownload ? 100 : Math.min(99, Math.round(fraction * 100));
        const received = stats?.bytesReceived ?? 0;
        const total = stats?.bytesTotal ?? 0;
        const speed = stats?.bytesPerSec ?? 0;
        const eta = stats?.etaSeconds ?? null;

        let titleText = `Downloading ${name}`;
        if (phase === 'verifying') titleText = `Verifying ${name}`;
        else if (phase === 'extracting') titleText = `Extracting ${name}`;
        else if (phase === 'downloading_projector') titleText = `Downloading vision projector for ${name}`;
        else if (phase === 'finalizing') titleText = `Finalizing ${name}`;

        let subtitleText = '';
        if (isPostDownload) {
          if (phase === 'verifying') subtitleText = 'Checking file integrity\u2026';
          else if (phase === 'extracting') subtitleText = 'Unpacking model files\u2026';
          else if (phase === 'finalizing') subtitleText = 'Almost done\u2026';
        } else if (isIndeterminate) {
          subtitleText = total > 0
            ? `${formatBytes(total)} \u00b7 Downloading in background`
            : 'Downloading in background';
        } else {
          const parts: string[] = [];
          if (total > 0) parts.push(`${formatBytes(received)} / ${formatBytes(total)}`);
          else if (received > 0) parts.push(formatBytes(received));
          if (speed > 50 * 1024) parts.push(`${formatBytes(speed)}/s`);
          if (eta != null && speed > 0) parts.push(`${formatEta(eta)} left`);
          subtitleText = parts.join(' \u00b7 ');
        }

        const barBg = cs === 'dark' ? '#2A2A2A' : '#E6E6E6';
        const barFill = cs === 'dark' ? '#3B82F6' : '#2563EB';
        const subColor = cs === 'dark' ? '#9BA1A6' : '#666666';
        const barWidth = isIndeterminate ? 35 : isPostDownload ? 100 : displayPct;
        return (
          <View key={name} className="px-4 py-2">
            <View className="flex-row items-center mb-1">
              <Text
                className="flex-1 text-sm text-theme-light-text-primary dark:text-theme-dark-text-primary"
                numberOfLines={1}
              >
                {titleText}
              </Text>
              {!isIndeterminate && !isPostDownload ? (
                <Text style={{ marginLeft: 8, fontSize: 12, color: subColor }}>
                  {displayPct}%
                </Text>
              ) : null}
              <TouchableOpacity
                onPress={() => cancelDownload(name)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginLeft: 10 }}
              >
                <Ionicons name="close-circle" size={22} color={subColor} />
              </TouchableOpacity>
            </View>
            <View
              style={{
                height: 4,
                width: '100%',
                backgroundColor: barBg,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  height: '100%',
                  width: `${barWidth}%` as `${number}%`,
                  backgroundColor: barFill,
                  opacity: isIndeterminate ? 0.55 : 1,
                }}
              />
            </View>
            {subtitleText ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                {(isIndeterminate || isPostDownload) && (
                  <ActivityIndicator size="small" color={subColor} />
                )}
                <Text style={{
                  fontSize: 11,
                  color: subColor,
                  marginLeft: (isIndeterminate || isPostDownload) ? 8 : 0,
                  flex: 1,
                }}>
                  {subtitleText}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
};

/**
 * Chat FlatList extracted out of <Home> so that the chatHistory
 * subscription lives here, not at the top of the Home tree. During
 * token streaming the store fires ~20×/sec — before this split,
 * the whole 3000-line Home component body re-ran every flush, which
 * was enough to peg the JS thread and trigger Android's
 * "app isn't responding / force stop" dialog on long stories.
 *
 * Now the token flush only re-renders this small wrapper; the
 * individual ChatMessageRowMemo still shallow-compares per row so
 * only the streaming row gets repainted.
 */
type ChatListProps = {
  flatRef: React.RefObject<FlatList<ChatMessage> | null>;
  renderMsg: ({ item }: { item: ChatMessage }) => React.ReactElement;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  atBottomRef: React.RefObject<boolean>;
  isAndroid: boolean;
};

const ChatList: React.FC<ChatListProps> = ({
  flatRef,
  renderMsg,
  onScroll,
  atBottomRef,
  isAndroid,
}) => {
  const chatHistory = useStore((s) => s.chatHistory);
  return (
    <FlatList
      ref={flatRef}
      data={chatHistory}
      renderItem={renderMsg}
      keyExtractor={(i) => i.id}
      className="flex-1 px-4"
      contentContainerStyle={{ paddingBottom: 16 }}
      onScroll={onScroll}
      scrollEventThrottle={32}
      onContentSizeChange={() => {
        if (atBottomRef.current) {
          flatRef.current?.scrollToEnd({ animated: true });
        }
      }}
      onLayout={() => {
        if (atBottomRef.current) {
          flatRef.current?.scrollToEnd({ animated: false });
        }
      }}
      maintainVisibleContentPosition={{
        minIndexForVisible: 0,
        autoscrollToTopThreshold: undefined,
      }}
      removeClippedSubviews={isAndroid}
      initialNumToRender={12}
      maxToRenderPerBatch={8}
      windowSize={9}
      updateCellsBatchingPeriod={32}
      disableVirtualization={false}
      keyboardShouldPersistTaps="handled"
    />
  );
};

/**
 * Combo mode keeps a text LLM and an image-generation model resident in
 * RAM at the same time. Each model's own pre-flight sizing (loadModel's
 * low-memory prompt for the text side, none for the image side) only
 * accounts for itself, so on a 4-6 GB device the pair can silently OOM.
 * Before the second of the two models is loaded, mirror the download-time
 * tiered RAM warning (see proceedWithMemoryCheck in HuggingfaceDownloadModel)
 * against the COMBINED footprint. Informative only — the user can always
 * proceed. Resolves true to load, false if the user backs out.
 */
async function confirmComboMemoryFootprint(
  textModel: Model,
  imageModel: Model,
): Promise<boolean> {
  const totalDeviceMemory = useStore.getState().totalDeviceMemory;
  const bytes =
    parseFileSizeString(textModel.size || '') +
    parseFileSizeString(imageModel.size || '');
  const ratio = totalDeviceMemory > 0 && bytes > 0 ? bytes / totalDeviceMemory : 0;
  if (ratio < 0.4) return true;

  return new Promise<boolean>((resolve) => {
    if (ratio >= 0.85) {
      themedAlert(
        'Very Likely to Crash',
        'Loading a text model and an image model together will exceed your estimated available memory. It will almost certainly crash. Load both anyway?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Load Anyway', style: 'destructive', onPress: () => resolve(true) },
        ]
      );
    } else if (ratio >= 0.65) {
      themedAlert(
        'High Risk of Crash',
        'Loading a text model and an image model together is large relative to your available memory. It may crash while loading. Load both?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Load Both', style: 'destructive', onPress: () => resolve(true) },
        ]
      );
    } else {
      themedAlert(
        'Moderate Memory Usage',
        'Loading a text model and an image model together will use a significant portion of your available memory. Continue?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ]
      );
    }
  });
}

/* ──────────────────────────────────────────────────────────────────
   COMPONENT
   ──────────────────────────────────────────────────────────────── */
const Home: React.FC = () => {
  /* STORE */
  // Per-field selectors. A bare `useStore()` call subscribes to the
  // entire state: any mutation — including the ~20×/sec chatHistory
  // updates during token streaming — would re-render this 3000-line
  // component. With individual selectors each field only fires its own
  // subscription. chatHistory lives inside <ChatList>; heavy download
  // fields live in <DownloadProgressHeader>.
  const selectedModel = useStore((s) => s.selectedModel);
  const selectedTextModel = useStore((s) => s.selectedTextModel);
  const selectedImageGenModel = useStore((s) => s.selectedImageGenModel);
  const comboModeEnabled = useStore((s) => s.comboModeEnabled);
  const activeCharacter = useStore((s) => s.activeCharacter);
  const addChatMessage = useStore((s) => s.addChatMessage);
  const updateChatMessage = useStore((s) => s.updateChatMessage);
  const startNewSessionOnAppOpen = useStore((s) => s.startNewSessionOnAppOpen);
  const startNewSession = useStore((s) => s.startNewSession);
  const isDownloading = useStore((s) => s.isDownloading);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const selectModel = useStore((s) => s.selectModel);
  const selectTextModel = useStore((s) => s.selectTextModel);
  const selectImageGenModel = useStore((s) => s.selectImageGenModel);
  const lastUsedModelName = useStore((s) => s.lastUsedModelName);
  const setLastUsedModelName = useStore((s) => s.setLastUsedModelName);
  const downloadedModels = useStore((s) => s.downloadedModels);
  const models = useStore((s) => s.models);
  const activeDownloads = useStore((s) => s.activeDownloads);
  const totalDeviceMemory = useStore((s) => s.totalDeviceMemory);
  // Track only whether any messages exist (for empty-state switch).
  // chatHistory itself is subscribed to inside <ChatList> only.
  const hasMessages = useStore((s) => s.chatHistory.length > 0);

  /* ───────────  Web-search state  ─────────── */
  const [searchEnabled, setSearchEnabled] = useState(false);
  const firstUseShown = useRef(false);
  const [webQuery, setWebQuery] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewMsgId, setPreviewMsgId] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const webKey = useRef(0);
  const pendingResolve = useRef<((t: string) => void) | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const originalInjectedJS = `
    (function () {
      const clickConsent = () => {
        const txt = /(I\\s*agree|Accept all|Agree & continue|I accept)/i;
        const btns=[...document.querySelectorAll('button,input[type="button"]')];
        btns.forEach(b=>{const v=b.innerText||b.value||'';if(txt.test(v)) b.click();});
      };
      clickConsent();
      function send(){
        try{window.ReactNativeWebView.postMessage(document.body.innerText||'');}
        catch(e){window.ReactNativeWebView.postMessage('');}
      }
      if(document.readyState==='complete'){setTimeout(send,800);}
      else window.addEventListener('load',()=>{clickConsent();setTimeout(send,800);});
    })(); true;`;

  // Inject a viewport that starts at 50% (0.5) scale and disallows further zooming:
  const zoomJS = `
  (function() {
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=0.5, maximum-scale=0.5, user-scalable=no';
    document.head.appendChild(meta);
  })();
`;
  // Generation settings are now persisted in the zustand store
  // (store/useGenSettingsSlice.ts). Every chat and every character
  // activation follows whatever the user last saved in the Settings
  // modal, across cold starts.
  const genSettings = useStore((s) => s.genSettings);
  const setGenSettings = useStore((s) => s.setGenSettings);

  const injectedJS = zoomJS + originalInjectedJS;

  /* googleSearch with logging */
  const googleSearch = useCallback(
    (q: string, keepChars: number): Promise<string> =>
      new Promise((resolve) => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => {
          setTimedOut(true);
          setPreviewVisible(false);
          resolve('');
        }, 10_000);

        pendingResolve.current = (txt) => {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          const core = txt.slice(139, 150 + keepChars);
          const context = `The latest current information from google search. Answer based on this:\n${core}`;
          // console.log(`[WEB_CONTEXT] (kept ${core.length})\n${context}`);
          resolve(context);
          // only auto‐close if the user has it turned on
          if (genSettings.autocloseWebView) {
            setPreviewVisible(false);
          }
        };

        webKey.current += 1;
        setWebQuery(q);
        setPreviewVisible(true);
      }),
    [genSettings.autocloseWebView] // ← re-run callback when flag changes
  );

  /* ───────────  Local UI state  ─────────── */
  const [llamaContext, setLlamaContext] = useState<LlamaContext | null>(null);
  const llamaContextRef = useRef<LlamaContext | null>(null);
  const isGeneratingRef = useRef(false);
  const modelMutexRef = useRef<Promise<void>>(Promise.resolve());
  // Track the currently-loaded text model so the NPU coordinator's
  // eviction handler can rebuild it on GPU/CPU when image gen takes
  // over the Hexagon DSP.
  const loadedTextModelRef = useRef<typeof selectedModel | null>(null);
  // True while the loaded context was created with MTP speculative decoding.
  const mtpActiveRef = useRef(false);
  const loadModelImplRef = useRef<((m: typeof selectedModel, opts?: LoadModelOptions) => Promise<boolean>) | null>(null);
  const unloadModelImplRef = useRef<(() => Promise<void>) | null>(null);
  const activeCompletionPromiseRef = useRef<Promise<any> | null>(null);
  const [inputText, setInputText] = useState('');
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [isImageModelReady, setIsImageModelReady] = useState(false);
  const [isImageModelLoading, setIsImageModelLoading] = useState(false);
  const [comboImageProgress, setComboImageProgress] = useState<{ step: number; total: number } | null>(null);
  const [inputHeight, setInputHeight] = useState(40);
  const [tokensPerSec, setTokensPerSec] = useState<number | null>(null);
  const tokenCount = useRef(0);
  const genStartTime = useRef(0);
  // Throttles tokens/sec state writes during streaming so we re-render
  // the header ~twice a second at most, regardless of flush frequency.
  // Without this every token flush triggered a Home re-render just to
  // update the speed readout.
  const tokensPerSecLastWriteRef = useRef(0);

  // Keep refs in sync with state for use inside streaming callbacks
  useEffect(() => { llamaContextRef.current = llamaContext; }, [llamaContext]);
  useEffect(() => { isGeneratingRef.current = isGenerating; }, [isGenerating]);

  const [isModelSettingsModalVisible, setIsModelSettingsModalVisible] =
    useState(false);
  const [isSettingsMenuVisible, setIsSettingsMenuVisible] = useState(false);
  const [loadStatusMsg, setLoadStatusMsg] = useState<string | null>(null);
  const loadStatusTimer = useRef<NodeJS.Timeout | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const modelContextSizeRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // The text model that was unloaded while the app sat in the background,
  // to be loaded again on return. Not `selectedModel`: in combo mode that
  // can be the image model.
  const bgReleasedModelRef = useRef<Model | null>(null);
  /** Timer that fires after BG_UNLOAD_DELAY_MS of being in the background.
   *  Cleared if the user returns to the app before it fires. */
  const bgUnloadTimerRef = useRef<NodeJS.Timeout | null>(null);
  const BG_UNLOAD_DELAY_MS = 2 * 60 * 1000; // 2 minutes

  /* ───────────  Vision state  ─────────── */
  const [isVisionEnabled, setIsVisionEnabled] = useState(false);
  const [imageAttachment, setImageAttachment] = useState<string | null>(null);
  const tokenBufferRef = useRef('');
  const tokenFlushTimer = useRef<NodeJS.Timeout | null>(null);
  const comboProcessorRef = useRef<ComboStreamProcessor | null>(null);
  // Tracks the last (model, character) we pre-warmed so we don't repeat it.
  const prewarmKeyRef = useRef<string | null>(null);
  // First history message kept in the last prompt, once a chat has been
  // trimmed (see selectHistoryWindow).
  const historyStartIdRef = useRef<string | null>(null);
  /**
   * Whether the currently-loaded model's chat template actually respects
   * the `enable_thinking` flag. Probed via getFormattedChat after load
   * (pocketpal-ai pattern). When null we don't know yet; when false the
   * toggle should be hidden from settings because it's a no-op.
   */
  const [thinkingSupported, setThinkingSupported] = useState<boolean | null>(
    null,
  );

  const showLoadStatus = (msg: string, durationMs = 4000) => {
    if (loadStatusTimer.current) clearTimeout(loadStatusTimer.current);
    setLoadStatusMsg(msg);
    loadStatusTimer.current = setTimeout(() => setLoadStatusMsg(null), durationMs);
  };

  const cs = useColorScheme() || 'light';
  const placeholderColor = cs === 'dark' ? '#E6E6E6' : '#666666';
  const spinnerColor = cs === 'dark' ? '#FFFFFF' : '#000000';

  /* keep awake - only during inference or download */
  useEffect(() => {
    if (isGenerating || isModelLoading || isDownloading) {
      activateKeepAwakeAsync('inference').catch(() => {});
    } else {
      deactivateKeepAwake('inference');
    }
    return () => { deactivateKeepAwake('inference'); };
  }, [isGenerating, isModelLoading, isDownloading]);

  const flatRef = useRef<FlatList<ChatMessage>>(null);
  const typingAnim = useRef(new Animated.Value(0)).current;
  const genId = useRef(0);
  const [imageGenKey, setImageGenKey] = useState(0);

  /* ───────────  Stick-to-bottom scroll  ───────────
     Standard ChatGPT/Claude/Gemini pattern:
     - Auto-scroll while generating ONLY if user is already at the bottom.
     - If user scrolls up to read history, auto-scroll stops.
     - When user scrolls back to the bottom, auto-scroll resumes.
     - Floating "scroll to bottom" pill appears while not at bottom. */
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const setAtBottomBoth = useCallback((v: boolean) => {
    atBottomRef.current = v;
    setAtBottom(v);
  }, []);
  const handleListScroll = useCallback(
    (e: any) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      // "At bottom" if within 60px of the end (accounts for padding + small drift)
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      const nowAtBottom = distanceFromBottom < 60;
      if (nowAtBottom !== atBottomRef.current) setAtBottomBoth(nowAtBottom);
    },
    [setAtBottomBoth],
  );
  const scrollToBottomNow = useCallback(() => {
    setAtBottomBoth(true);
    requestAnimationFrame(() => {
      flatRef.current?.scrollToEnd({ animated: true });
    });
  }, [setAtBottomBoth]);

  /* drawer anim */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dw = Dimensions.get('window').width * 0.75;
  const drawerAnim = useRef(new Animated.Value(-dw)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const homeAnim = useRef(new Animated.Value(0)).current;

  /* keyboard layout anim */
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () =>
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    );
    const hide = Keyboard.addListener('keyboardWillHide', () =>
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /* session/model effects (same logic as original) */
  useEffect(() => {
    startNewSession();
    startNewSessionOnAppOpen();
  }, []);
  useEffect(() => {
    // Auto-load the last-used model on launch — only when the user has
    // opted in. Default-off because a model that crashes on init (bad
    // quant, corrupt download, OOM) used to put the app in a crash loop
    // with no chance to flip a setting between relaunches.
    if (!genSettings.autoLoadLastModel) return;
    if (!selectedModel && lastUsedModelName) {
      const ok = downloadedModels.includes(`${lastUsedModelName}.gguf`);
      if (ok) {
        const m = models.find((m) => m.name === lastUsedModelName);
        if (m) selectModel(m);
      }
    }
  }, []);
  // ─── Effect: Text model loading ─────────────────────────────────
  // In combo mode, watches selectedTextModel. In legacy mode, watches
  // selectedModel but skips image gen models.
  useEffect(() => {
    const textModel = comboModeEnabled ? selectedTextModel : selectedModel;
    if (!textModel) return;
    // Never load image gen models through llama.rn
    if (isImageGenModel(textModel)) {
      // Legacy mode only: unload llama context so SD can use the RAM
      if (!comboModeEnabled && llamaContextRef.current) {
        (async () => {
          if (isGeneratingRef.current) await stopGen();
          await doUnloadModel();
        })();
      }
      return;
    }
    const alreadyLoaded =
      !!llamaContextRef.current &&
      loadedTextModelRef.current?.name === textModel.name;
    // ALSO skip if we're already loading this exact model. Effect deps
    // include `comboModeEnabled` and `selectedModel`; toggling either
    // mid-load used to re-trigger loadModel and restart the whole
    // pipeline (file probe → backend resolve → initLlama). That's the
    // "loading twice" feel the user reported.
    if (alreadyLoaded || loadingModelNameRef.current === textModel.name) return;
    (async () => {
      // Combo mode: if an image model is already resident, this text model
      // is the second of the pair to load — warn on the combined RAM
      // footprint before committing. Backing out clears the text slot.
      if (comboModeEnabled) {
        const imageModel = useStore.getState().selectedImageGenModel;
        if (imageModel && !(await confirmComboMemoryFootprint(textModel, imageModel))) {
          selectTextModel(null);
          return;
        }
      }
      if (isGeneratingRef.current) {
        await stopGen();
      }
      setTokensPerSec(null);
      tokenCount.current = 0;
      const ok = await loadModel(textModel);
      genId.current += 1;
      if (!ok) {
        if (comboModeEnabled) selectTextModel(null);
        else selectModel(null);
      }
    })();
  }, [selectedModel, selectedTextModel, comboModeEnabled]);

  // ─── Effect: Image gen model loading (combo mode) ─────────────────
  useEffect(() => {
    if (!comboModeEnabled || !selectedImageGenModel) {
      setIsImageModelReady(false);
      setIsImageModelLoading(false);
      return;
    }
    // Load via the shared image-gen-service
    let cancelled = false;
    setIsImageModelReady(false);
    setIsImageModelLoading(true);
    (async () => {
      try {
        // Combo mode: if a text model is already resident, this image
        // model is the second of the pair to load — warn on the combined
        // RAM footprint first. Backing out clears the image slot.
        const textModel = useStore.getState().selectedTextModel;
        if (textModel && !(await confirmComboMemoryFootprint(textModel, selectedImageGenModel))) {
          if (cancelled) return;
          setIsImageModelReady(false);
          setIsImageModelLoading(false);
          selectImageGenModel(null);
          return;
        }
        if (cancelled) return;
        await ImageGenService.loadImageModel(selectedImageGenModel.name);
        if (!cancelled) {
          setIsImageModelReady(true);
          setIsImageModelLoading(false);
          useStore.setState({ lastUsedImageGenModelName: selectedImageGenModel.name });
        }
      } catch (err: any) {
        if (!cancelled) {
          setIsImageModelReady(false);
          setIsImageModelLoading(false);
          console.error('[Home] Failed to load image gen model:', err?.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedImageGenModel, comboModeEnabled]);

  // ─── Effect: Combo image generation progress listener ──────────────
  useEffect(() => {
    if (!comboModeEnabled) return;
    const sub = ImageGenService.addProgressListener((e) => {
      setComboImageProgress({ step: e.step, total: e.totalSteps });
    });
    return () => sub.remove();
  }, [comboModeEnabled]);

  // Start a fresh chat session whenever the user activates / deactivates
  // a character so the conversation matches the new persona. Also stops any
  // in-flight generation so its tokens don't bleed into the new session,
  // and seeds the chat with the character's `firstMessage` (if present)
  // so the user has a strong in-character starting point — the standard
  // SillyTavern / chub.ai pattern.
  //
  // Exception: if the user picked the 'llm' greeting mode, we skip seeding
  // the scripted first_message so the model's fresh generation becomes the
  // visible opener instead of a canned line. The scripted text is still
  // used below as part of the system context so the model can riff off it.
  useEffect(() => {
    (async () => {
      if (isGeneratingRef.current) {
        await stopGen();
      }
      genId.current += 1;
      setTokensPerSec(null);
      tokenCount.current = 0;
      setAtBottomBoth(true);
      startNewSession();
      // Seed greeting from the character's first_message field (if any)
      const mode = useStore.getState().genSettings.characterGreeting;
      if (mode !== 'llm' && activeCharacter?.firstMessage?.trim()) {
        addChatMessage({
          id: `${Date.now()}-greet`,
          sender: 'Model',
          message: activeCharacter.firstMessage.trim(),
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCharacter?.id]);

  // ───────────  Character system-prompt PRE-WARM  ───────────
  // When a character + model are both ready, we want to hide the latency
  // of the first user message. The user's `characterGreeting` preference
  // (in Settings) picks between three behaviours:
  //
  //   'scripted' (default) — if the card has a hand-written first_message,
  //        seed it as the opening assistant message (already handled in the
  //        previous useEffect) and do a zero-token pre-warm so the KV cache
  //        matches the chat history. If there's no first_message, fall
  //        through to LLM generation so the user still gets an opener.
  //
  //   'llm' — always let the model generate the opener, even when the card
  //        ships a scripted first_message. The scripted text is injected
  //        into the system context so the model can riff off it, but the
  //        visible message is a fresh generation. This is what the user
  //        asked for: "the pretext should be sent to the llm already, with
  //        an instruction to respond, and the llm replies first."
  //
  //   'off' — no auto-greeting. Cheap cache-warm only, blank opener.
  //
  // Guarded by prewarmKeyRef so we never fire twice for the same
  // (model, character) combo, and aborts if a real generation is already
  // running.
  useEffect(() => {
    if (!llamaContext || !activeCharacter) return;
    const key = `${selectedModel?.name ?? ''}::${activeCharacter.id}`;
    if (prewarmKeyRef.current === key) return;
    if (isGeneratingRef.current) return;
    prewarmKeyRef.current = key;

    const scriptedFirstMessage = activeCharacter.firstMessage?.trim() || '';
    const hasScriptedGreeting = scriptedFirstMessage.length > 0;
    const mode = genSettings.characterGreeting;
    // The model generates the opener when the user picked 'llm', or when
    // they picked 'scripted' but the card has no scripted first_message.
    // 'off' always falls to the cheap cache-warm path.
    const shouldGenerate =
      mode === 'llm' || (mode === 'scripted' && !hasScriptedGreeting);
    const baseSys = buildCharacterSystemPrompt(activeCharacter);
    // In 'llm' mode, fold the scripted opener into the system context so
    // the model has access to the card author's intended tone without
    // actually showing it as the visible first message.
    const prewarmSys =
      mode === 'llm' && hasScriptedGreeting
        ? `${baseSys}\n\n# Card's default opener (for reference — craft a fresh in-character opener instead of repeating this)\n${scriptedFirstMessage}`
        : baseSys;

    (async () => {
      try {
        if (!shouldGenerate) {
          // Cheap cache-warm path. Feeds the system prompt + (if present)
          // the scripted greeting as an assistant turn so the KV cache
          // matches what handleSendOrStop will see in chatHistory.
          const prewarmMsgs: any[] = [
            { role: 'system', content: prewarmSys },
          ];
          if (hasScriptedGreeting) {
            prewarmMsgs.push({
              role: 'assistant',
              content: scriptedFirstMessage,
            });
          }
          await llamaContext.completion({
            messages: prewarmMsgs,
            n_predict: 0,
            temperature: 0,
            top_p: 1,
            ...(mtpActiveRef.current && { speculative: false }),
          } as any);
        } else {
          // Generative path — the model streams a short in-character
          // opener into the chat. Warms the KV cache AND gives the user
          // something to respond to.
          const botId = `greet-${Date.now()}`;
          addChatMessage({
            id: botId,
            sender: 'Model',
            message: '',
            isStreaming: true,
          });

          setIsGenerating(true);
          isGeneratingRef.current = true;
          tokenCount.current = 0;
          genStartTime.current = Date.now();
          const myGen = ++genId.current;

          tokenBufferRef.current = '';
          const prewarmPromise = llamaContext.completion(
            {
              messages: [
                { role: 'system', content: prewarmSys },
                {
                  role: 'user',
                  content:
                    '[Start the roleplay by greeting me in character. One short in-scene paragraph. Do not break character, do not explain yourself, do not ask what to do — just open the scene.]',
                },
              ],
              n_predict: 180,
              stop: STANDARD_STOP_WORDS,
              temperature: Math.max(genSettings.temperature, 0.85),
              top_p: Math.max(genSettings.topP, 0.92),
              min_p: 0.05,
              repeat_penalty: 1.1,
              enable_thinking: false,
              reasoning_format: 'none',
              ...(mtpActiveRef.current && { speculative: MTP_SPECULATIVE }),
            } as any,
            (d) => {
              if (!isGeneratingRef.current || !d.token) return;
              if (myGen !== genId.current) return;
              tokenBufferRef.current += d.token;
              if (!tokenFlushTimer.current) {
                tokenFlushTimer.current = setTimeout(() => {
                  const buffered = tokenBufferRef.current;
                  tokenBufferRef.current = '';
                  tokenFlushTimer.current = null;
                  if (myGen !== genId.current) return;
                  updateChatMessage(botId, (p) => ({
                    ...p,
                    message: partialCleanup(p.message + buffered),
                  }));
                }, 50);
              }
            },
          );
          activeCompletionPromiseRef.current = prewarmPromise;
          const res = await prewarmPromise;
          activeCompletionPromiseRef.current = null;

          if (tokenFlushTimer.current) {
            clearTimeout(tokenFlushTimer.current);
            tokenFlushTimer.current = null;
          }

          if (myGen === genId.current) {
            updateChatMessage(botId, {
              message: finalCleanup(res.text || ''),
              isStreaming: false,
            });
          }
        }
      } catch (err) {
        // Pre-warm failure is harmless — the real first message will just
        // pay the prefill cost as usual.
        if (__DEV__) console.warn('[prewarm] failed (non-fatal):', err);
      } finally {
        // Only the generative path touches isGenerating, so only that
        // path needs to flip it back. The cheap cache-warm never does.
        if (shouldGenerate) {
          setIsGenerating(false);
          isGeneratingRef.current = false;
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llamaContext, activeCharacter?.id]);
  useEffect(() => () => { void unloadModel(); }, []);

  /* AppState: delay-unload model after being in background for 2 minutes.
     Previously the model was unloaded IMMEDIATELY on background, which
     meant even a quick app switch (checking a notification, replying to
     a message) caused a full reload when the user came back. Now we set
     a 2-minute timer. If the user returns before it fires, the timer is
     cancelled and the model stays hot. If the timer fires, we unload to
     reclaim RAM. On return from a timed-out background, we reload. */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (prev === 'active' && (next === 'background' || next === 'inactive')) {
        // Going to background — start the delayed unload timer.
        // Don't unload immediately — the user might be back in seconds.
        if (llamaContextRef.current && !bgUnloadTimerRef.current) {
          bgUnloadTimerRef.current = setTimeout(() => {
            bgUnloadTimerRef.current = null;
            // Only unload if we're still in the background when the timer fires
            if (appStateRef.current !== 'active' && llamaContextRef.current) {
              bgReleasedModelRef.current = loadedTextModelRef.current;
              void unloadModel();
            }
          }, BG_UNLOAD_DELAY_MS);
        }
      } else if (next === 'active' && prev !== 'active') {
        // Returning to foreground — cancel the unload timer if it hasn't
        // fired yet (user came back within 2 minutes, model stays hot).
        if (bgUnloadTimerRef.current) {
          clearTimeout(bgUnloadTimerRef.current);
          bgUnloadTimerRef.current = null;
        }
        // If the timer DID fire while we were away, reload the model and
        // keep the conversation that was on screen.
        const released = bgReleasedModelRef.current;
        if (released) {
          bgReleasedModelRef.current = null;
          (async () => {
            const ok = await loadModel(released, { keepSession: true });
            if (!ok) {
              if (useStore.getState().comboModeEnabled) selectTextModel(null);
              else selectModel(null);
            }
          })();
        }
      }
    });
    return () => {
      sub.remove();
      if (bgUnloadTimerRef.current) {
        clearTimeout(bgUnloadTimerRef.current);
        bgUnloadTimerRef.current = null;
      }
    };
  }, [llamaContext, isGenerating, selectedModel]);

  /* typing loop */
  useEffect(() => {
    if (isGenerating) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(typingAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(typingAnim, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else typingAnim.setValue(0);
  }, [isGenerating]);

  /* drawer helpers */
  const openDrawer = () => {
    setDrawerOpen(true);
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0.5,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(homeAnim, {
        toValue: dw,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  };
  const closeDrawer = () => {
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: -dw,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(homeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => setDrawerOpen(false));
  };

  /* model load helpers
   *
   * Cancellable loads: when the user taps a different model while one is
   * still loading, we want the in-flight load to abandon and the new
   * load to take over. initLlama is a blocking native call that we
   * can't actually interrupt mid-execution, but we CAN:
   *   1. Bump a generation counter on each new load.
   *   2. After each `await` checkpoint, check whether our generation
   *      is still the latest. If not, throw a sentinel so the load
   *      tears down whatever it's allocated and exits silently.
   *   3. Newer load waits on the mutex, then runs unimpeded.
   *
   * The user perceives: "I tapped B mid-A, B is what loads." The
   * worst case is having to wait through A's current native call to
   * complete (then A is immediately released and B starts).
   */
  const loadGenRef = useRef(0);
  const SUPERSEDED = Symbol('load-superseded');

  /**
   * Robustly release an llama.rn context. llama.rn rc.7+ added
   * `throwIfContextBusy` to its mutable APIs — release() can throw
   * with "context busy" when something inside the context (e.g. a
   * pending completion, a multimodal init still finalising) is still
   * touching it. The previous code wrapped release() in `try { ... }
   * catch {}` and silently swallowed those failures, leaving the
   * native model weights allocated. Two failed releases in a row
   * means two models worth of RAM resident at the same time, and
   * lmkd kills the app — that's the OOM we diagnosed in the user's
   * 05-04 logcat (3.78 GB rss + 4 GB swap on a 12 GB phone).
   *
   * This helper:
   *   1. Stops any in-flight completion first (so the context isn't
   *      "busy" when we ask it to release).
   *   2. Awaits the active completion promise to drain.
   *   3. Calls release(). On a busy-error, waits 200 ms and retries
   *      once — gives any straggling native callback time to finish.
   *   4. Logs each step so we can see exactly where a leak happened
   *      via the in-app log viewer.
   */
  const safeReleaseContext = async (ctx: LlamaContext, label: string): Promise<boolean> => {
    try {
      // Stop completion first — most common reason a context is "busy".
      try { await ctx.stopCompletion(); } catch (e) {
        if (__DEV__) console.warn(`[safeRelease] ${label} stopCompletion threw:`, e);
      }
      // Wait for any in-flight completion promise to settle.
      if (activeCompletionPromiseRef.current) {
        try { await activeCompletionPromiseRef.current; } catch {}
        activeCompletionPromiseRef.current = null;
      }
      await ctx.release();
      console.log(`[safeRelease] ${label} released OK`);
      return true;
    } catch (e: any) {
      console.warn(`[safeRelease] ${label} release failed (${e?.message ?? e}); retrying after 200 ms`);
      await new Promise<void>((r) => setTimeout(r, 200));
      try {
        await ctx.release();
        console.log(`[safeRelease] ${label} released OK on retry`);
        return true;
      } catch (e2: any) {
        console.error(`[safeRelease] ${label} release FINAL FAILURE — context leaked: ${e2?.message ?? e2}`);
        return false;
      }
    }
  };
  // Name of the model currently being loaded (null when idle). Used by
  // the useEffect below to avoid re-issuing loadModel(X) when X is
  // already in flight — that used to happen when an unrelated dep
  // (comboModeEnabled, selectedModel) changed during a load and felt
  // like "the model is loading twice". Cleared in loadModel's finally.
  const loadingModelNameRef = useRef<string | null>(null);
  // Most-recently-generated image in combo mode, queued for the NEXT
  // user turn so a vision LLM can actually see what it produced. Used
  // for ONE turn only, then cleared — re-sending on every turn would
  // force the CLIP encoder to run repeatedly.
  const pendingVisionImageRef = useRef<string | null>(null);
  const loadModel = async (model: typeof selectedModel, opts?: LoadModelOptions) => {
    if (!model) return false;
    // Mark any in-flight load as superseded BEFORE waiting on the mutex
    // so they can bail at their next checkpoint instead of finishing
    // their entire pipeline.
    const myGen = ++loadGenRef.current;
    const prevTarget = loadingModelNameRef.current;
    loadingModelNameRef.current = model.name;
    console.log(`[loadModel] requested "${model.name}" gen=${myGen}${opts?.forceNonNpu ? ' forceNonNpu' : ''}${prevTarget && prevTarget !== model.name ? ` (replacing in-flight "${prevTarget}")` : ''}`);
    const prev = modelMutexRef.current;
    let release!: () => void;
    modelMutexRef.current = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    // After the previous load finishes (or aborts), confirm we're still
    // the most-recent request before doing any work.
    if (loadGenRef.current !== myGen) {
      console.log(`[loadModel] gen=${myGen} superseded before mutex acquire — skipping`);
      release();
      // Don't clear loadingModelNameRef here — a newer load owns it.
      return false;
    }
    try {
      const result = await doLoadModel(model, opts, myGen);
      console.log(`[loadModel] gen=${myGen} "${model.name}" finished, ok=${result}`);
      return result;
    } catch (e) {
      if (e === SUPERSEDED) {
        console.log(`[loadModel] gen=${myGen} "${model.name}" superseded mid-load`);
        return false;
      }
      throw e;
    } finally {
      // Only clear the in-flight ref if we're STILL the latest request —
      // otherwise a newer load already grabbed it and we'd wipe its target.
      if (loadGenRef.current === myGen) {
        loadingModelNameRef.current = null;
      }
      release();
    }
  };
  // Throw if our generation no longer matches the latest. Caller's catch
  // clause swallows SUPERSEDED so the abandoned load exits silently.
  const checkLoadGen = (myGen: number) => {
    if (loadGenRef.current !== myGen) throw SUPERSEDED;
  };

  const doLoadModel = async (model: typeof selectedModel, opts?: LoadModelOptions, myGen: number = loadGenRef.current): Promise<boolean> => {
    if (!model) return false;
    // Always unload the previous context first, then yield a tick to
    // give the kernel a moment to actually reclaim the freed pages
    // before we try to allocate the new model. Without this delay,
    // the new model's native allocation can race with the previous
    // model's munmap → both resident → lmkd kills the app.
    await doUnloadModel();
    await new Promise<void>((r) => setTimeout(r, 50));
    checkLoadGen(myGen);

    let modelBytes = 0;
    let ratio = 0;
    // Hoisted so the outer catch / finally can release it on unexpected
    // failures further down the load flow.
    let textNpuReserved = false;

    try {
      // Reset progress to 0 explicitly — a previous load (especially a
      // superseded one that hit our initLlama supersede check) might
      // leave loadingProgress non-zero, which would briefly show a
      // partial progress bar at the start of the next load. Setting it
      // here too means the UI starts fresh every load.
      setLoadingProgress(0);
      setIsModelLoading(true);

      // Check both new public path and old private path for backward
      // compat. Probe both in parallel — they're independent fs.exists
      // calls and one of them is going to miss anyway, so doing them
      // concurrently halves preflight latency on the cold path.
      const newDir = getModelsDir();
      const oldDir = getLegacyModelsDir();
      const newPath = `${newDir}/${model.name}.gguf`;
      const oldPath = `${oldDir}/${model.name}.gguf`;
      const [newExists, oldExists] = await Promise.all([
        ReactNativeBlobUtil.fs.exists(newPath),
        ReactNativeBlobUtil.fs.exists(oldPath),
      ]);
      const path = newExists ? newPath : oldExists ? oldPath : null;
      if (!path) {
        themedAlert('Model Not Found', `"${model.name}" not downloaded.`);
        return false;
      }
      checkLoadGen(myGen);

      // Validate the GGUF file BEFORE handing it to the native loader.
      // A truncated / partial / corrupt download will crash llama.cpp
      // inside its native parsing — no JS try/catch can save us from
      // that, the whole app dies. Catching it here surfaces a clear
      // "redownload" prompt instead.
      const validation = await validateGgufFile(path);
      if (!validation.ok) {
        themedAlert(
          'Model File Corrupt',
          `"${model.name}" failed integrity check: ${validation.reason}.\n\n` +
          `This usually means the download was interrupted. ` +
          `Delete the model and download it again to fix.`,
        );
        return false;
      }
      checkLoadGen(myGen);

      // Auto-detect the actual model architecture from the GGUF header.
      // If the store thinks this is a text LLM but the file is actually
      // an image-gen model (e.g. a sideloaded SD 1.5 / Flux GGUF), bail
      // here instead of letting llama.rn try to parse it as a text LLM
      // and either fail loudly or quietly produce gibberish. The store
      // entry for files coming through our own download flow is
      // already correct via gguf-detect post-download — this is
      // defense-in-depth for sideloaded / mislabelled cases.
      const detected = await detectGgufModelType(path);
      if (detected.modelType === 'imageGen') {
        themedAlert(
          'Wrong Model Type',
          `"${model.name}" appears to be an image-generation model (architecture: ${detected.architecture ?? 'unknown'}). It can't be loaded as a chat model.\n\n` +
          `Use the image generation panel to load image models instead.`,
        );
        return false;
      }
      // llama.cpp refuses any architecture it doesn't know, and the three
      // load attempts below would each fail with a vague error. Say what
      // is actually wrong instead.
      if (detected.architecture && !isSupportedTextArch(detected.architecture)) {
        themedAlert(
          'Model Not Supported Yet',
          `"${model.name}" uses the "${detected.architecture}" architecture, which this version of the app can't run. ` +
          `Update the app if a newer version is available, or pick a different model.`,
        );
        return false;
      }
      checkLoadGen(myGen);

      // ──────────────────────────────────────────────────────────────────
      //  MINIMAL PARAMS — match the original working commit (497c2bd).
      //
      //  We pass ONLY: model path, use_mlock, n_ctx, n_gpu_layers, and
      //  optionally `devices` for NPU (Hexagon HTP) selection.
      //
      //  Hardware acceleration is resolved via resolveHardwareBackend()
      //  which probes available backends: NPU → GPU → CPU with fallbacks.
      // ──────────────────────────────────────────────────────────────────
      const isAndroid = Platform.OS === 'android';

      // Kick off the hardware-backend probe in parallel with the memory
      // analysis below. resolveHardwareBackend calls into llama.rn's
      // getBackendDevicesInfo, which on Android can take 100-300ms the
      // first time. Running it concurrently with the fs.stat() shaves
      // that off the user-visible load latency. We compute the
      // EFFECTIVE preference here (factoring in NPU coordination) so
      // the result we await is final.
      const userPrefForProbe = genSettings.hardwareAcceleration;
      const npuBlockedForProbe = opts?.forceNonNpu || npuCoordinator.getOwner() === 'image';
      const probePref: HardwareAccelMode =
        npuBlockedForProbe && (userPrefForProbe === 'auto' || userPrefForProbe === 'npu')
          ? 'gpu'
          : userPrefForProbe;
      const hwBackendPromise = resolveHardwareBackend(probePref, model.name, isAndroid);

      // Memory analysis (concurrent with the backend probe above)
      const stat = await ReactNativeBlobUtil.fs.stat(path);
      modelBytes = stat?.size ?? 0;
      const totalDeviceMemory = useStore.getState().totalDeviceMemory;
      ratio = (totalDeviceMemory > 0 && modelBytes > 0)
        ? modelBytes / totalDeviceMemory : 0;

      // Pre-flight memory check. If the model is clearly too large for
      // available RAM, show a two-button alert:
      //   • OK — abort loading (safe default)
      //   • Try Anyway (Slow) — skip mlock, use paged/mmap with a tiny
      //     context window. This is the "hybrid" mode that pages parts
      //     of the model from disk on demand. Much slower than RAM but
      //     won't crash the OS.
      let forceHybrid = false;
      if (totalDeviceMemory > 0 && modelBytes > 0) {
        const estimatedNeed = modelBytes * 1.2 + 256 * 1024 * 1024;
        if (estimatedNeed > totalDeviceMemory * 1.05) {
          const estGB = Math.round(estimatedNeed / 1024 / 1024 / 1024 * 10) / 10;
          const availGB = Math.round(totalDeviceMemory / 1024 / 1024 / 1024 * 10) / 10;
          // Wait for the user's decision before proceeding
          const userChoice = await new Promise<'cancel' | 'force'>((resolve) => {
            themedAlert(
              'Low Memory',
              `This model needs ~${estGB} GB but only ~${availGB} GB is available.\n\n` +
              `You can close other apps and try again, or force-load in hybrid mode — ` +
              `the model will partially load from disk on demand, which is significantly ` +
              `slower but avoids crashing. Context window will be reduced to 512 tokens.`,
              [
                { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
                { text: 'Try Anyway (Slow)', style: 'destructive', onPress: () => resolve('force') },
              ],
            );
          });
          if (userChoice === 'cancel') return false;
          forceHybrid = true;
        }
      }

      // Compute baseline context window — leave headroom for OS + app.
      // If the user chose "Try Anyway" above, cap at 512 tokens to
      // minimize the KV cache memory footprint.
      const safeCtx = forceHybrid
        ? 512
        : totalDeviceMemory > 0 && modelBytes > 0
          ? Math.min(genSettings.contextLength, Math.max(512, Math.floor((totalDeviceMemory - modelBytes) / (4 * 1024))))
          : genSettings.contextLength;

      // Hardware backend decision — the probe was kicked off above in
      // parallel with the file stat. Now we await it (or override to
      // CPU when the user accepted the hybrid trade-off).
      //
      // NPU coordination: if the image generator currently owns the Hexagon
      // DSP (or the caller forced non-NPU via the eviction path), demote
      // 'auto'/'npu' preferences to 'gpu' so the LLM doesn't try to attach
      // to the same DSP. Explicit 'cpu'/'gpu' preferences pass through
      // unchanged — they never touch the NPU anyway.
      const userPref = userPrefForProbe;
      const npuBlocked = npuBlockedForProbe;
      let hwBackend = forceHybrid
        ? { mode: 'cpu' as const, devices: undefined as string[] | undefined, nGpuLayers: 0, deviceLabel: 'CPU', warning: null as string | null }
        : await hwBackendPromise;

      // Demotion driven by image-gen owning the NPU is silent — the user
      // is already mid-image-gen flow and a popup would be noisy. The
      // device tag in showLoadStatus still reflects the actual backend
      // (CPU/GPU), so it's discoverable. We only log for debugging.
      if (npuBlocked && (userPref === 'auto' || userPref === 'npu')) {
        if (__DEV__) console.log('[loadModel] NPU owned by image gen — text loading on GPU/CPU');
      }

      // Reserve the NPU for text BEFORE initLlama if we plan to use HTP.
      // This blocks any concurrent image-NPU acquire from racing the load.
      // If reservation fails (image owns NPU after all — e.g. just acquired
      // between resolveHardwareBackend and here), demote silently to GPU.
      if (hwBackend.mode === 'npu') {
        textNpuReserved = await npuCoordinator.reserveText();
        if (!textNpuReserved) {
          if (__DEV__) console.log('[loadModel] reserveText denied — falling back to GPU');
          hwBackend = await resolveHardwareBackend('gpu', model.name, isAndroid);
        }
      }

      // Last checkpoint before the expensive native call. If a newer
      // load arrived while we were probing, abandon now — saves us
      // from spending 10-30s on initLlama only to discard the result.
      checkLoadGen(myGen);

      const nGpuLayers = hwBackend.nGpuLayers;
      const hwDevices = hwBackend.devices;

      // llama.rn's progress callback already passes 0-100, not 0-1.
      const onProgress = (p: number) => {
        const pct = p > 1 ? Math.round(p) : Math.round(p * 100);
        setLoadingProgress(Math.max(0, Math.min(100, pct)));
      };

      // Every load attempt below goes through here. A model with MTP
      // layers is tried with speculative decoding first; if the same
      // attempt then succeeds without it, MTP is what failed, and it
      // stays off for the rest of this load.
      let useMtp = detected.mtpLayers > 0 && genSettings.speculativeDecoding;
      const init = async (params: any): Promise<LlamaContext> => {
        if (useMtp) {
          try {
            return await initLlama({ ...params, speculative: MTP_SPECULATIVE }, onProgress);
          } catch (mtpErr) {
            console.warn('[loadModel] init with MTP failed, trying without:', mtpErr);
            const plain = await initLlama(params, onProgress);
            useMtp = false;
            return plain;
          }
        }
        return initLlama(params, onProgress);
      };

      // Loading strategy:
      //  • Normal path: try mlock first (fast), fall back to paged if mlock fails
      //  • Force-hybrid path: skip mlock entirely, go straight to paged with
      //    minimal context (the user already accepted the speed trade-off)
      let ctx: LlamaContext | null = null;
      let usedFallback = forceHybrid;

      const perf = getPerfParams(path);

      if (forceHybrid) {
        // Skip mlock — go straight to the safest possible configuration.
        // use_mlock: false tells llama.cpp to use mmap (paged from disk).
        // n_ctx: 512 is the minimum useful window. CPU only, no devices.
        try {
          ctx = await init({
            model: path,
            use_mlock: false,
            use_mmap: perf.mmapHint,
            n_ctx: safeCtx,
            n_gpu_layers: 0,
            n_threads: perf.n_threads,
            n_batch: perf.n_batch,
            n_ubatch: perf.n_ubatch,
            ctx_shift: true,
          });
        } catch (hybridErr: any) {
          const errMsg = String(hybridErr || '').toLowerCase();
          if (errMsg.includes('oom') || errMsg.includes('memory') || errMsg.includes('alloc') || errMsg.includes('enomem')) {
            themedAlert(
              'Out of Memory',
              'Not enough RAM even in hybrid mode. This model is too large for this device.',
            );
          } else {
            themedAlert('Error', `Failed to load model: ${hybridErr?.message || 'The file may be corrupted or incompatible.'}`);
          }
          return false;
        }
      } else {
        // Normal path: try with selected hardware backend + mlock first,
        // fall back to CPU + paged if that fails.
        // ctx_shift must be disabled on Android + GPU: the OpenCL backend
        // SIGSEGVs on the ggml set op used by KV cache shifting. It's a
        // context init param (not completion), so it goes here.
        const useCtxShift = !(Platform.OS === 'android' && nGpuLayers > 0);
        const initParams: any = {
          model: path,
          use_mlock: true,
          // mlock pins everything in RAM, so mmap setting is largely
          // irrelevant here, but follow the repackable-quant hint
          // anyway — it sidesteps any first-load mmap+repack stall.
          use_mmap: perf.mmapHint,
          n_ctx: safeCtx,
          n_gpu_layers: nGpuLayers,
          n_threads: perf.n_threads,
          n_batch: perf.n_batch,
          n_ubatch: perf.n_ubatch,
          ctx_shift: useCtxShift,
        };
        // Pass devices for NPU (Hexagon HTP) selection
        if (hwDevices) initParams.devices = hwDevices;

        try {
          ctx = await init(initParams);
        } catch (accelErr) {
          if (__DEV__) console.warn(`[loadModel] ${hwBackend.mode} load failed, trying CPU fallback:`, accelErr);
          // If we were using GPU/NPU, retry with pure CPU before giving up
          if (nGpuLayers > 0) {
            const failedMode = hwBackend.mode;
            try {
              ctx = await init({
                model: path,
                use_mlock: true,
                use_mmap: perf.mmapHint,
                n_ctx: safeCtx,
                n_gpu_layers: 0,
                n_threads: perf.n_threads,
                n_batch: perf.n_batch,
                n_ubatch: perf.n_ubatch,
                ctx_shift: true,
              });
              hwBackend.mode = 'cpu';
              hwBackend.deviceLabel = 'CPU (mlock)';
              hwBackend.warning = `${failedMode === 'npu' ? 'NPU' : 'GPU'} failed — loaded on CPU instead.`;
            } catch {
              // CPU+mlock also failed — try paged
            }
          }
          if (!ctx) {
            // Last resort: CPU + paged (mmap)
            try {
              usedFallback = true;
              ctx = await init({
                model: path,
                use_mlock: false,
                use_mmap: perf.mmapHint,
                n_ctx: Math.min(safeCtx, 1024),
                n_gpu_layers: 0,
                n_threads: perf.n_threads,
                n_batch: perf.n_batch,
                n_ubatch: perf.n_ubatch,
                ctx_shift: true,
              });
              hwBackend.mode = 'cpu';
              hwBackend.deviceLabel = 'CPU (paged)';
            } catch (fallbackErr: any) {
              const errMsg = String(fallbackErr || '').toLowerCase();
              if (errMsg.includes('oom') || errMsg.includes('memory') || errMsg.includes('alloc') || errMsg.includes('enomem')) {
                themedAlert(
                  'Out of Memory',
                  'Not enough RAM to load this model even in fallback mode. Close background apps or try a smaller model.',
                );
              } else {
                themedAlert('Error', `Failed to load model: ${fallbackErr?.message || 'The file may be corrupted or incompatible.'}`);
              }
              if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
              return false;
            }
          }
        }
        // mlock succeeded on first try but we should still try paged fallback
        // if mlock specifically failed (not other errors)
        if (!ctx) {
          if (__DEV__) console.warn('[loadModel] mlock failed, trying paged');
          try {
            usedFallback = true;
            ctx = await init({
              model: path,
              use_mlock: false,
              use_mmap: perf.mmapHint,
              n_ctx: Math.min(safeCtx, 1024),
              n_gpu_layers: 0,
              n_threads: perf.n_threads,
              n_batch: perf.n_batch,
              n_ubatch: perf.n_ubatch,
            });
            hwBackend.mode = 'cpu';
            hwBackend.deviceLabel = 'CPU (paged)';
          } catch (fallbackErr: any) {
            const errMsg = String(fallbackErr || '').toLowerCase();
            if (errMsg.includes('oom') || errMsg.includes('memory') || errMsg.includes('alloc') || errMsg.includes('enomem')) {
              themedAlert(
                'Out of Memory',
                'Not enough RAM to load this model even in fallback mode. Close background apps or try a smaller model.',
              );
            } else {
              themedAlert('Error', `Failed to load model: ${fallbackErr?.message || 'The file may be corrupted or incompatible.'}`);
            }
            if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
            return false;
          }
        }
      }

      if (!ctx) {
        themedAlert('Error', 'Failed to create model context.');
        if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
        return false;
      }

      // initLlama just returned — if a newer load came in during the
      // long native call, immediately release this context and bail.
      // The new load is already queued behind the mutex.
      if (loadGenRef.current !== myGen) {
        await safeReleaseContext(ctx, `superseded "${model.name}" gen=${myGen}`);
        if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
        throw SUPERSEDED;
      }

      // NPU coordinator bookkeeping. If we reserved the NPU for text and
      // ended up actually loading on NPU, confirm the reservation still
      // holds — image gen could have grabbed the DSP during the long
      // initLlama call, in which case we need to abandon and re-init on
      // GPU. If we ended up on CPU/GPU (fallback path or non-HTP from the
      // start), release any reservation we held.
      if (hwBackend.mode === 'npu' && textNpuReserved) {
        if (!npuCoordinator.confirmText()) {
          console.warn('[loadModel] NPU was claimed by image gen during text init — reloading on GPU/CPU');
          await safeReleaseContext(ctx, `npu-evicted "${model.name}" gen=${myGen}`);
          return doLoadModel(model, { ...opts, forceNonNpu: true }, myGen);
        }
      } else if (textNpuReserved) {
        // Reserved NPU but didn't end up using it (CPU fallback path).
        npuCoordinator.noteTextNotOnNpu();
      }

      setLlamaContext(ctx);
      setLastUsedModelName(model.name);
      setLoadingProgress(0);
      modelContextSizeRef.current = safeCtx;
      loadedTextModelRef.current = model;
      mtpActiveRef.current = useMtp;
      if (useMtp) console.log(`[loadModel] "${model.name}" loaded with MTP speculative decoding`);
      if (!opts?.keepSession) startNewSession();

      // Probe whether this model's chat template actually respects the
      // `enable_thinking` flag. Non-reasoning models (Gemma 3, Llama 3.x,
      // Phi-4, Qwen 2.5, SmolLM) silently ignore it — the toggle is a
      // no-op on those. When the template returns a non-empty
      // thinking_start_tag we know the model can think; otherwise we
      // hide the toggle from settings. Pattern borrowed from pocketpal-ai.
      try {
        const probe: any = await ctx.getFormattedChat(
          [
            { role: 'system', content: 'x' },
            { role: 'user', content: 'x' },
          ],
          null,
          { jinja: true, enable_thinking: true },
        );
        const tag: string | undefined = probe?.thinking_start_tag;
        setThinkingSupported(!!(tag && tag.length > 0));
      } catch {
        setThinkingSupported(null); // Unknown — keep toggle visible
      }

      // ──────────────────────────────────────────────────────────────────
      //  VISION (mmproj) — pocketpal pattern: ALWAYS CPU on Android.
      //  GPU vision encoders crash too often on Adreno; the speed loss is
      //  worth the stability gain. iOS Metal can handle GPU vision fine.
      //
      //  Retry behaviour: we try up to 3 times with 400 ms gaps between
      //  attempts. This catches the race where the user taps "Use Model"
      //  the instant the mmproj DownloadManager broadcasts complete — on
      //  some Android devices the .part → .gguf rename and the inode
      //  metadata flush lag behind the broadcast by a few hundred ms. A
      //  first-try failure then reports "files missing or corrupt" even
      //  though a manual eject-and-reload immediately after works fine,
      //  which is exactly the reported symptom.
      // ──────────────────────────────────────────────────────────────────
      const mmProjNamed = `${newDir}/${model.name}.mmproj.gguf`;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // Only models flagged with mmProjUrl declare vision capability.
      // Skipping the search entirely for text-only models avoids two
      // problems we hit before:
      //   1) The fallback search (any *mmproj*.gguf in Downloads)
      //      could grab a stale projector from a previously-downloaded
      //      vision model and try to attach it to an unrelated LLM.
      //      That mmproj's expected n_embd doesn't match the new
      //      model, so initMultimodal silently fails and we waste
      //      ~6s on retries — visible to the user as a second
      //      spinner cycle after the progress bar finishes.
      //   2) For text-only models, the mmproj retry loop is pure
      //      latency — there's never a projector to find.
      const modelHasVision = !!model.mmProjUrl;

      const findMmProjPath = async (): Promise<string | null> => {
        // Strict named match first — works for our download flow which
        // saves the projector as `<modelName>.mmproj.gguf`.
        if (await ReactNativeBlobUtil.fs.exists(mmProjNamed)) return mmProjNamed;
        // Fallback global search ONLY for models that declare vision.
        // Without this guard, text-only models could pick up the wrong
        // projector from a sibling vision model in the Downloads folder.
        if (!modelHasVision) return null;
        for (const dir of [newDir, oldDir]) {
          try {
            const dirExists = await ReactNativeBlobUtil.fs.isDir(dir);
            if (!dirExists) continue;
            const files = await ReactNativeBlobUtil.fs.ls(dir);
            for (const f of files) {
              const lower = f.toLowerCase();
              if (!lower.endsWith('.gguf')) continue;
              // Only match a projector that's clearly tied to THIS
              // model's name. Generic "mmproj" / "projector" hits
              // would otherwise grab a sibling model's projector.
              const modelLower = model.name.toLowerCase();
              const isOurs = lower.includes(modelLower) || modelLower.includes(lower.replace('.gguf', ''));
              if (!isOurs) continue;
              if (lower.includes('mmproj') || lower.includes('projector') ||
                  (lower.includes('clip') && lower.includes('vit'))) {
                return `${dir}/${f}`;
              }
            }
          } catch {}
        }
        return null;
      };

      // tryEnableVision returns one of:
      //   'ready'      — mmproj attached, vision works
      //   'retryable'  — transient (file just landed, size still 0,
      //                  inode race). Try again after 400 ms.
      //   'permanent'  — file exists and is well-sized but
      //                  initMultimodal returned false. Almost always
      //                  a dimension mismatch (wrong projector for
      //                  this model). Retrying won't help — bail.
      type VisionResult = 'ready' | 'retryable' | 'permanent';
      const tryEnableVision = async (): Promise<VisionResult> => {
        const path = await findMmProjPath();
        if (!path) return modelHasVision ? 'retryable' : 'permanent';
        const st = await ReactNativeBlobUtil.fs.stat(path).catch(() => null);
        // <10 KB is almost certainly a half-finished download or error
        // page, not a real projector. Truly retryable.
        if (!st || Number(st.size ?? 0) < 10 * 1024) {
          console.log('[mmproj] file too small (retryable):', path, st?.size);
          return 'retryable';
        }
        try {
          const ok = await ctx.initMultimodal({ path, use_gpu: !isAndroid });
          if (ok) return 'ready';
          // initMultimodal returned false on a real, well-sized file.
          // That's a structural mismatch (e.g. projector emits 1536-d
          // embeddings but this LLM expects 2560-d). No amount of
          // retrying recovers it.
          console.warn('[mmproj] initMultimodal returned false — incompatible projector for this model');
          return 'permanent';
        } catch (visErr) {
          console.warn('[mmproj] init threw (retryable):', visErr);
          return 'retryable';
        }
      };

      let visionReady = false;
      if (modelHasVision) {
        try {
          for (let attempt = 0; attempt < 3 && !visionReady; attempt++) {
            if (attempt > 0) await sleep(400);
            const result = await tryEnableVision();
            if (result === 'ready') {
              visionReady = true;
              break;
            }
            if (result === 'permanent') {
              console.log(`[mmproj] giving up after attempt ${attempt + 1} — permanent failure`);
              break;
            }
          }
        } catch (visErr) {
          console.warn('[mmproj] unexpected error:', visErr);
        }
      }
      setIsVisionEnabled(visionReady);

      // Self-healing recovery: the model SAYS it has vision (has a
      // mmProjUrl in the catalog) but we still couldn't enable it after
      // retries. This usually means the mmproj download was aborted on a
      // previous run. Tell the user clearly instead of silently loading
      // text-only.
      if (!visionReady && model.mmProjUrl) {
        themedAlert(
          'Vision Not Available',
          `${model.name} has vision support, but the vision projector file is missing or corrupted. The model will still work for text. To enable image input, delete and re-download the model from the model list.`,
        );
      }

      // Build a human-readable status string showing:
      //   • Model size
      //   • Load mode: RAM (mlock succeeded) or Hybrid (paged fallback)
      //   • What % of device RAM the model uses
      //   • Context window size
      //   • Compute device: CPU / GPU / NPU with actual device name
      //   • Vision availability
      //
      // Examples:
      //   "2.8 GB | RAM (45% of RAM) | ctx: 2048 | CPU | Vision"
      //   "769 MB | Hybrid (12% of RAM) | ctx: 1024 | CPU (paged)"
      //   "2.0 GB | RAM (30% of RAM) | ctx: 2048 | Adreno 740 (GPU)"
      //   "2.0 GB | RAM (30% of RAM) | ctx: 2048 | HTP0 (NPU)"

      // Compute device tag — prefer llama.rn's reported devices, fall
      // back to hwBackend's label from our pre-flight probe.
      let deviceTag = '';
      if (ctx.gpu && ctx.devices?.length) {
        deviceTag = ctx.devices.join(', ');
      } else if (ctx.gpu) {
        deviceTag = ctx.androidLib || hwBackend.deviceLabel;
      } else if (hwBackend.mode !== 'cpu' && !usedFallback) {
        // We requested GPU/NPU — show what we got from the resolver
        deviceTag = hwBackend.deviceLabel;
      } else if (ctx.reasonNoGPU) {
        deviceTag = `CPU (${ctx.reasonNoGPU})`;
      } else {
        deviceTag = usedFallback ? 'CPU (paged)' : 'CPU (mlock)';
      }

      // Load mode: RAM vs Hybrid
      const loadMode = usedFallback ? 'Hybrid' : 'RAM';
      const sizeMB = Math.round(modelBytes / 1024 / 1024);
      const sizeStr = sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`;
      const ramPct = ratio > 0 ? `${Math.round(ratio * 100)}% of RAM` : '';
      const visionTag = visionReady ? ' | Vision' : '';
      const finalCtx = usedFallback ? Math.min(safeCtx, 1024) : safeCtx;
      showLoadStatus(
        `${sizeStr} | ${loadMode} (${ramPct}) | ctx: ${finalCtx} | ${deviceTag}${visionTag}`,
        5000,
      );

      if (usedFallback) {
        themedAlert(
          'Loaded in Hybrid Mode',
          'Not enough free RAM to lock the model in memory. Loaded with paged memory and a smaller context window. Frequently used parts stay in RAM, the rest loads from disk on demand. Close other apps for better speed.',
        );
      }

      // Hardware-fallback warnings are no longer surfaced as popups — the
      // device tag in showLoadStatus already reflects the actual backend
      // (NPU / GPU / CPU) and the runtime fallback in initLlama catches
      // real failures. Keep the warning string on hwBackend for logs only.
      if (__DEV__ && hwBackend.warning) {
        console.log('[loadModel] backend note:', hwBackend.warning);
      }

      return true;
    } catch (e: any) {
      // Superseded loads bubble up through here too — re-throw so the
      // public loadModel wrapper can swallow them silently. No alert,
      // no error log.
      if (e === SUPERSEDED) {
        if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
        throw e;
      }
      if (__DEV__) console.error('[loadModel] unexpected error:', e);
      themedAlert('Error', `Failed to load model: ${e?.message || 'Unexpected error.'}`);
      if (textNpuReserved) npuCoordinator.noteTextNotOnNpu();
      return false;
    } finally {
      setIsModelLoading(false);
      setLoadingProgress(0);
    }
  };
  const doUnloadModel = async () => {
    const ctx = llamaContextRef.current;
    const priorName = loadedTextModelRef.current?.name ?? null;
    if (ctx) {
      console.log(`[unloadModel] releasing context for "${priorName ?? '(unknown)'}"`);
      // Mark the generation flag false BEFORE attempting release so
      // `safeReleaseContext` doesn't think a completion is still in
      // flight. The active completion promise is awaited inside the
      // helper itself.
      if (isGeneratingRef.current) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
      }
      await safeReleaseContext(ctx, `unload "${priorName ?? '(unknown)'}"`);
      // Always null the refs even if release ultimately failed —
      // we don't want the leaked context to be reused.
      setLlamaContext(null);
      llamaContextRef.current = null;
    }
    loadedTextModelRef.current = null;
    mtpActiveRef.current = false;
    npuCoordinator.noteTextUnloaded();
    setIsVisionEnabled(false);
    setImageAttachment(null);
  };

  // Public unload — serialized through the mutex
  const unloadModel = async () => {
    const prev = modelMutexRef.current;
    let release!: () => void;
    modelMutexRef.current = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      await doUnloadModel();
    } finally {
      release();
    }
  };

  // Keep refs to load/unload functions so the NPU coordinator's eviction
  // handler (registered once at mount) can invoke the latest closures.
  loadModelImplRef.current = loadModel;
  unloadModelImplRef.current = unloadModel;

  // Register the NPU eviction handler once. When image gen grabs the
  // Hexagon DSP and the LLM is currently using HTP, the coordinator
  // calls this handler to reload the LLM on GPU/CPU (transparent
  // demotion). Goes through the public `loadModel` so the model mutex
  // serializes correctly with any other load/unload in flight.
  useEffect(() => {
    npuCoordinator.registerTextEvictHandler(async () => {
      const model = loadedTextModelRef.current;
      const reload = loadModelImplRef.current;
      const unload = unloadModelImplRef.current;
      if (!model || !reload) {
        // No text model loaded (or refs not yet populated) — best-effort
        // unload so the DSP is fully released for the image side.
        try { await unload?.(); } catch {}
        return;
      }
      console.log('[home] NPU evict requested — reloading text model on GPU/CPU');
      try { showLoadStatus('Switching chat to GPU mode for image generation…', 4000); } catch {}
      try {
        await reload(model, { forceNonNpu: true, keepSession: true });
      } catch (e) {
        console.warn('[home] NPU eviction reload failed:', e);
        try { await unload?.(); } catch {}
      }
    });
    return () => npuCoordinator.registerTextEvictHandler(null);
  }, []);
  const handleEjectModel = async (name: string) => {
    // Check combo mode slots first
    if (selectedTextModel?.name === name) {
      await unloadModel();
      selectTextModel(null);
    }
    if (selectedImageGenModel?.name === name) {
      await ImageGenService.unloadImageModel();
      selectImageGenModel(null);
      setIsImageModelReady(false);
    }
    // Legacy fallback
    if (selectedModel?.name === name) {
      if (!isImageGenModel(selectedModel)) await unloadModel();
      selectModel(null);
    }
  };

  /* image picker for vision — pick from photos or files */
  const handlePickImage = async () => {
    if (!isVisionEnabled) {
      themedAlert('No Vision Model', 'Load a vision model (with mmproj) to enable image input.');
      return;
    }
    themedAlert('Add Image', 'Choose image source', [
      {
        text: 'Photo Library',
        onPress: async () => {
          try {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.8,
            });
            if (!result.canceled && result.assets?.[0]?.uri) {
              setImageAttachment(result.assets[0].uri);
            }
          } catch (e: any) {
            themedAlert('Error', `Failed to pick image: ${e?.message || 'Unknown'}`);
          }
        },
      },
      {
        text: 'Camera',
        onPress: async () => {
          try {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) {
              themedAlert('Permission Denied', 'Camera permission is required.');
              return;
            }
            const result = await ImagePicker.launchCameraAsync({
              quality: 0.8,
            });
            if (!result.canceled && result.assets?.[0]?.uri) {
              setImageAttachment(result.assets[0].uri);
            }
          } catch (e: any) {
            themedAlert('Error', `Failed to capture image: ${e?.message || 'Unknown'}`);
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  /* send / stop */
  const stopGen = async () => {
    isGeneratingRef.current = false;
    setIsGenerating(false);
    // Cancel any combo stream image generations in flight
    if (comboProcessorRef.current) {
      comboProcessorRef.current.cancel();
      comboProcessorRef.current = null;
    }
    try {
      await llamaContext?.stopCompletion();
    } catch (err) {
      if (__DEV__) console.error('stopGen error:', err);
    }
    // Wait for the active completion to actually settle
    if (activeCompletionPromiseRef.current) {
      try { await activeCompletionPromiseRef.current; } catch {}
      activeCompletionPromiseRef.current = null;
    }
  };
  const handleSendOrStop = async () => {
    if (isGenerating) {
      stopGen();
      return;
    }
    if (!inputText.trim() && !imageAttachment) return;
    if (!selectedModel || !llamaContext) {
      themedAlert('No model loaded', 'Please select a model first.');
      return;
    }

    const userText = inputText.trim();
    const currentImage = imageAttachment;
    setInputText('');
    setInputHeight(40);
    setImageAttachment(null);

    if (userText && !checkChatText(userText).allowed) {
      addChatMessage({ id: Date.now().toString(), sender: 'User', message: userText });
      addChatMessage({ id: (Date.now() + 1).toString(), sender: 'Model', message: CHAT_BLOCKED_REPLY });
      return;
    }

    const myGen = ++genId.current;

    // Taken before this turn's messages are added: the new user message
    // goes into the prompt on its own, so it must not also come back
    // through the history.
    const priorHistory = useStore.getState().chatHistory;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: 'User',
      message: userText || '(image)',
      imageUri: currentImage || undefined,
    };
    addChatMessage(userMsg);
    if (searchEnabled) setPreviewMsgId(userMsg.id);

    setIsGenerating(true);
    isGeneratingRef.current = true;
    setTokensPerSec(null);
    tokenCount.current = 0;
    genStartTime.current = Date.now();
    tokensPerSecLastWriteRef.current = 0;

    const botId = (Date.now() + 1).toString();
    addChatMessage({
      id: botId,
      sender: 'Model',
      message: '',
      isStreaming: true,
    });

    try {
      const imageModelReady = comboModeEnabled && isImageModelReady;
      const sys: RNLlamaOAICompatibleMessage = activeCharacter
        ? {
            role: 'system',
            content: buildCharacterSystemPrompt(activeCharacter, {
              comboMode: comboModeEnabled,
              imageModelLoaded: imageModelReady,
            }),
          }
        : {
            role: 'system',
            content: imageModelReady
              ? `You are a helpful assistant with image generation capability.

# Image Generation
You can generate images! When the user asks you to generate, create, draw, or show an image, you MUST output the tag: [IMG: detailed visual description]

Example:
User: "generate an image of a cat"
You: "Here's a cat for you! [IMG: a fluffy orange tabby cat sitting on a windowsill, soft natural lighting, cozy atmosphere, detailed fur texture]"

Rules:
- Always use [IMG: description] when the user asks for any image, photo, picture, or drawing
- The description must be detailed: subject, setting, lighting, style, mood
- You can include conversational text before or after the [IMG: ...] tag
- NEVER say you cannot generate images — you CAN, using the [IMG: ...] tag
- Never describe nudity, underwear, swimwear, sexual or violent content inside [IMG: ...]

${CHAT_CONTENT_RULE}`
              : `You are a helpful assistant.\n\n${CHAT_CONTENT_RULE}`,
          };

      let webCtx = '';
      if (searchEnabled) {
        try {
          webCtx = await googleSearch(userText, genSettings.webContextChars);
        } catch {}
      }

      const msgs: RNLlamaOAICompatibleMessage[] = [sys];
      if (webCtx) {
        msgs.push({
          role: 'system',
          content: `Relevant Google info (retrieved ${new Date()
            .toISOString()
            .slice(0, 10)}):\n${webCtx}`,
        });
      }

      // History, trimmed to ~55% of the context window (45% is reserved
      // for the reply; off-grid-mobile-ai uses the same split). See
      // lib/chat-context.ts for how old images and the cut point are
      // handled.
      const ctxBudget = modelContextSizeRef.current || genSettings.contextLength;
      const inputBudget = Math.floor(ctxBudget * 0.55);
      const fixedTokens =
        msgs.reduce((n, m) => n + (typeof m.content === 'string' ? estimateTokens(m.content) : 0), 0) +
        estimateTokens(userText);
      const historyWindow = selectHistoryWindow(
        priorHistory,
        fixedTokens,
        inputBudget,
        historyStartIdRef.current,
      );
      historyStartIdRef.current = historyWindow.startId;
      const historyMsgs: RNLlamaOAICompatibleMessage[] = historyWindow.messages;

      // Build the current user message (with image if attached). Image
      // priority order:
      //   1. User-uploaded image (currentImage)
      //   2. Most-recent combo-generated image (pendingVisionImageRef)
      //      — only attached when the user has the
      //      `feedGeneratedImageToVision` setting on, and only for ONE
      //      turn, then cleared so the vision encoder doesn't run on
      //      every follow-up turn.
      //   3. Text-only otherwise.
      // We always clear the queued ref even when the setting is off,
      // so toggling on later doesn't suddenly resurface a stale image.
      const queuedGenerated = pendingVisionImageRef.current;
      pendingVisionImageRef.current = null;
      const visionImage =
        currentImage ||
        (isVisionEnabled && genSettings.feedGeneratedImageToVision ? queuedGenerated : null);
      let currentUserMsg: RNLlamaOAICompatibleMessage;
      if (visionImage && isVisionEnabled) {
        const url = visionImage.startsWith('file://') ? visionImage : `file://${visionImage}`;
        const parts: RNLlamaMessagePart[] = [
          { type: 'image_url', image_url: { url } },
        ];
        if (userText) parts.push({ type: 'text', text: userText });
        currentUserMsg = { role: 'user', content: parts };
      } else {
        currentUserMsg = { role: 'user', content: userText };
      }

      msgs.push(...historyMsgs, currentUserMsg);

      // Post-history instruction: small LLMs drift over multi-turn chats.
      // A short reminder right before generation pulls the model back into
      // character. This is the same technique SillyTavern uses — and card
      // creators can supply their own via Character Card V2's
      // post_history_instructions field, which we honor when present.
      if (activeCharacter) {
        const reminder =
          activeCharacter.postHistoryInstructions?.trim() ||
          `[Reminder: You are ${activeCharacter.name}. Stay fully in character. Respond naturally as ${activeCharacter.name} would, with their voice and personality.]`;
        msgs.push({
          role: 'system',
          content: `${reminder}\n[Keep it non-sexual and suitable for a general audience.]`,
        });
      }

      // Roleplay sampling boost: when a character is active, automatically use sampling
      // values tuned for vivid, in-character responses without changing the user's saved
      // settings. The user can still manually override via the Settings modal — the boost
      // only kicks in if their saved values are below the roleplay sweet spot.
      const isRoleplay = !!activeCharacter;
      const effectiveTemp = isRoleplay
        ? Math.max(genSettings.temperature, 0.85)
        : genSettings.temperature;
      const effectiveTopP = isRoleplay
        ? Math.max(genSettings.topP, 0.92)
        : genSettings.topP;

      // Token streaming with buffer flush (~50ms batches for smooth UI)
      tokenBufferRef.current = '';

      // Set up combo stream processor if image model is loaded
      if (imageModelReady) {
        comboProcessorRef.current = createComboStreamProcessor({
          onVisibleTextUpdate: (text) => {
            updateChatMessage(botId, (p) => ({
              ...p,
              message: partialCleanup(text),
            }));
          },
          onImageGenerationStart: (prompt, placeholderId) => {
            addChatMessage({
              id: placeholderId,
              sender: 'Model',
              message: '',
              isGeneratingImage: true,
              imagePrompt: prompt,
            });
          },
          onImageGenerationComplete: (placeholderId, imageUri) => {
            updateChatMessage(placeholderId, {
              isGeneratingImage: false,
              imageUri,
              message: '',
            });
            // Queue the just-generated image for the next user turn so
            // a vision-capable LLM can actually see what it just made
            // when the user asks a follow-up. Cleared after one turn.
            pendingVisionImageRef.current = imageUri;
          },
          onImageGenerationError: (placeholderId, error) => {
            updateChatMessage(placeholderId, {
              isGeneratingImage: false,
              message: `Failed to generate image: ${error}`,
            });
          },
        }, {
          steps: genSettings.comboImageSteps,
          cfgScale: genSettings.comboImageCfgScale,
          imageSize: genSettings.comboImageSize,
          negativePrompt: genSettings.comboImageNegativePrompt,
        });
      } else {
        comboProcessorRef.current = null;
      }
      // Cap generation at 1024 tokens (not the full context window).
      // Using the full n_ctx as n_predict wastes context budget and some
      // models generate unnecessarily long responses before hitting a stop.
      const maxGenTokens = Math.min(1024, genSettings.contextLength);
      // Output guard: the reply is checked as it streams. A trailing
      // window keeps the check O(n) over the response; it's wide enough
      // for every multi-word term in content-safety.ts.
      let streamedText = '';
      let outputBlocked = false;
      const completionPromise = llamaContext.completion(
        {
          messages: msgs,
          n_predict: maxGenTokens,
          stop: STANDARD_STOP_WORDS,
          temperature: effectiveTemp,
          top_p: effectiveTopP,
          top_k: 40,
          // Roleplay anti-repetition + diversity boost (small LLMs love to loop phrases)
          ...(isRoleplay && {
            min_p: 0.05,
            repeat_penalty: 1.1,
            repeat_last_n: 64,
            presence_penalty: 0.3,
          }),
          // Thinking mode control — works on Qwen3, DeepSeek-R1, GLM, etc. via jinja templates.
          // For Gemma 4 we use 'none' because its thinking blocks use the
          // asymmetric <|channel>...<channel|> format which llama.rn's
          // 'deepseek' stripper doesn't understand — we parse it ourselves.
          enable_thinking: genSettings.enableThinking,
          reasoning_format: (() => {
            if (!genSettings.enableThinking) return 'none';
            const name = (loadedTextModelRef.current?.name || '').toLowerCase();
            if (name.includes('gemma-4') || name.includes('gemma4')) return 'none';
            return 'deepseek';
          })(),
          // MTP is text-only in llama.rn: a request that carries an image
          // has to switch it off or the completion is rejected.
          ...(mtpActiveRef.current && {
            speculative: typeof currentUserMsg.content === 'string' ? MTP_SPECULATIVE : false,
          }),
        } as any,
        (d) => {
          // Bail early if generation was stopped — prevents leftover tokens after stop
          if (!isGeneratingRef.current || !d.token || outputBlocked) return;
          tokenCount.current += 1;
          streamedText += d.token;
          if (!checkChatText(streamedText.slice(-400)).allowed) {
            outputBlocked = true;
            tokenBufferRef.current = '';
            comboProcessorRef.current?.cancel();
            void llamaContext.stopCompletion().catch(() => {});
            return;
          }

          // ─── Combo mode: route tokens through the stream processor ───
          if (imageModelReady && comboProcessorRef.current) {
            comboProcessorRef.current.feedToken(d.token);
            // Tokens/sec readout — throttled to ~2 Hz so the header
            // doesn't force a Home re-render on every token.
            const now = Date.now();
            const elapsed = (now - genStartTime.current) / 1000;
            if (elapsed > 0.5 && now - tokensPerSecLastWriteRef.current > 500) {
              tokensPerSecLastWriteRef.current = now;
              setTokensPerSec(Math.round((tokenCount.current / elapsed) * 10) / 10);
            }
            return;
          }

          // ─── Normal mode: buffer + flush ─────────────────────────────
          tokenBufferRef.current += d.token;

          // Flush buffer at ~50ms intervals to prevent UI jank
          if (!tokenFlushTimer.current) {
            tokenFlushTimer.current = setTimeout(() => {
              const buffered = tokenBufferRef.current;
              tokenBufferRef.current = '';
              tokenFlushTimer.current = null;
              const now = Date.now();
              const elapsed = (now - genStartTime.current) / 1000;
              if (elapsed > 0.5 && now - tokensPerSecLastWriteRef.current > 500) {
                tokensPerSecLastWriteRef.current = now;
                setTokensPerSec(Math.round((tokenCount.current / elapsed) * 10) / 10);
              }
              // Incremental cleanup: only normalize/strip-markers over
              // the tail of the existing message + the new chunk, not
              // the entire growing response. partialCleanup's ops are
              // idempotent on already-cleaned text, so the prefix
              // doesn't need to be re-processed. 128-char overlap is
              // comfortably larger than every marker we strip
              // (<|constrain|>…<| is the longest, typically <40 chars),
              // so markers that span the chunk boundary still get
              // caught. Saves O(n²) work across a streaming response.
              const CLEANUP_OVERLAP = 128;
              updateChatMessage(botId, (p) => {
                if (p.message.length <= CLEANUP_OVERLAP) {
                  return { ...p, message: partialCleanup(p.message + buffered) };
                }
                const prefix = p.message.slice(0, -CLEANUP_OVERLAP);
                const cleaned = partialCleanup(p.message.slice(-CLEANUP_OVERLAP) + buffered);
                return { ...p, message: prefix + cleaned };
              });
            }, 50);
          }
        }
      );
      activeCompletionPromiseRef.current = completionPromise;
      const res = await completionPromise;
      activeCompletionPromiseRef.current = null;

      // Finalize combo stream processor (flush any pending buffer)
      if (comboProcessorRef.current) {
        comboProcessorRef.current.finalize();
        comboProcessorRef.current = null;
      }

      // Flush any remaining buffered tokens
      if (tokenFlushTimer.current) {
        clearTimeout(tokenFlushTimer.current);
        tokenFlushTimer.current = null;
      }
      if (tokenBufferRef.current) {
        tokenBufferRef.current = '';
      }

      if (myGen !== genId.current) return;

      if (outputBlocked) {
        updateChatMessage(botId, { message: CHAT_BLOCKED_REPLY, isStreaming: false });
        return;
      }

      // Use native timings for final accurate tokens/sec
      if (res.timings?.predicted_per_second > 0) {
        setTokensPerSec(Math.round(res.timings.predicted_per_second * 10) / 10);
      }
      if (res.draft_tokens > 0) {
        console.log(`[mtp] ${res.draft_tokens_accepted}/${res.draft_tokens} drafted tokens accepted`);
      }

      // In combo mode the visible text was already updated via the processor
      const finalText = imageModelReady
        ? require('@/lib/image-tag-parser').parseImageTags(res.text).visibleText
        : res.text;
      updateChatMessage(botId, {
        message: finalCleanup(finalText),
        isStreaming: false,
      });
      // Only scroll to bottom if user is following along — don't yank them
      // back if they've scrolled up to read history.
      if (atBottomRef.current) {
        flatRef.current?.scrollToEnd({ animated: true });
      }
    } catch (e) {
      if (__DEV__) console.error(e);
      // Catch ggml / OOM / alloc-style native errors and try to recover
      // the KV cache so the user can retry without a full model reload.
      // Borrowed from off-grid-mobile-ai's safeCompletion wrapper.
      const errMsg = String((e as any)?.message ?? e ?? '').toLowerCase();
      const isMemoryError =
        /ggml|abort|sigabrt|tensor|alloc|out of memory|oom|enomem|context/i.test(errMsg);
      if (isMemoryError) {
        try {
          await (llamaContext as any)?.clearCache?.(true);
        } catch {}
        themedAlert(
          'Generation Failed',
          'The model ran out of context or memory. The cache has been cleared — try a shorter prompt, fewer attachments, or a smaller context window in Settings.',
        );
      } else {
        themedAlert('Error', 'Failed to generate a response.');
      }
      updateChatMessage(botId, { message: '', isStreaming: false });
    } finally {
      activeCompletionPromiseRef.current = null;
      if (myGen === genId.current) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
      }
    }
  };

  const handleNewChat = async () => {
    if (isGeneratingRef.current) {
      await stopGen();
    }
    genId.current += 1;
    setImageGenKey(k => k + 1);
    setTokensPerSec(null);
    tokenCount.current = 0;
    setAtBottomBoth(true);
    startNewSession();
  };

  /* render message */
  // Stable callback for the WebView message handler so renderMsg
  // doesn't have to recreate it on every render. The handler mutates
  // a ref (not state) so it's safe to capture once.
  const handleWebViewMessage = useCallback((data: string) => {
    pendingResolve.current?.(data);
    pendingResolve.current = null;
    setWebQuery(null);
  }, []);

  // Pass only the bits of parent state each row actually cares about
  // so React.memo can skip unchanged rows. renderMsg itself is
  // memoized with useCallback so FlatList sees a stable reference —
  // without this, every token-stream re-render would invalidate all
  // cached rows and trigger the VirtualizedList slow-update warning.
  // Only surface the character name in chat / typing indicator when
  // there's actually a text model loaded to roleplay it. Otherwise we
  // can show "Alice is typing…" while there's no model behind it,
  // which is confusing — particularly right after app launch when an
  // active character is restored from persisted state but the model
  // isn't loaded yet (autoload off).
  const characterName = llamaContext && activeCharacter ? activeCharacter.name : null;
  const webKeyCurrent = webKey.current;
  const renderMsg = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <ChatMessageRowMemo
        item={item}
        showPreview={previewMsgId === item.id && previewVisible}
        previewTimedOut={timedOut}
        webQuery={webQuery}
        webKeyVal={webKeyCurrent}
        injectedJS={injectedJS}
        onWebViewMessage={handleWebViewMessage}
        cs={cs}
        typingAnim={typingAnim}
        characterName={characterName}
        imageProgress={item.isGeneratingImage ? comboImageProgress : null}
      />
    ),
    [
      previewMsgId,
      previewVisible,
      timedOut,
      webQuery,
      webKeyCurrent,
      injectedJS,
      handleWebViewMessage,
      cs,
      typingAnim,
      characterName,
      comboImageProgress,
    ],
  );

  /* download progress is handled by system notification bar */

  /* input grow */
  const onInputSizeChange = (
    e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) => {
    const h = e.nativeEvent.contentSize.height;
    const max = 6 * 40;
    setInputHeight(Math.min(h < 48 ? 40 : h, max));
  };

  /* header helpers */
  const arrowBg = cs === 'dark' ? '#FFFFFF' : '#000000';
  const arrowColor = cs === 'dark' ? '#000000' : '#FFFFFF';
  const createColor = cs === 'dark' ? '#FFFFFF' : '#000000';
  // Header title rules:
  //   1. Character name — ONLY when a text model is actually loaded.
  //      An active character without a loaded model used to leak in
  //      after app launch (the active character persists across cold
  //      starts but the model doesn't, especially with the
  //      autoload-last-model toggle off) and showed the character
  //      name in the header even though there was nothing to chat
  //      with. Now we fall through to the model labels in that case.
  //   2. Combo dual-model label.
  //   3. Single selected model name.
  //   4. "Select Model" placeholder.
  const headerTitle = llamaContext && activeCharacter
    ? activeCharacter.name
    : comboModeEnabled && selectedTextModel && selectedImageGenModel
      ? `${selectedTextModel.name.slice(0, 6)}..+${selectedImageGenModel.name.slice(0, 6)}..`
      : selectedModel
        ? selectedModel.name
        : 'Select Model';

  /* ──────────────────────────────────────────────────────────────
     RENDER
     ──────────────────────────────────────────────────────────── */
  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      className="flex-1 bg-theme-light-background dark:bg-theme-dark-background"
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 60 : 0}
      >
      <Animated.View style={{ flex: 1, transform: [{ translateX: homeAnim }] }}>
        {/* HEADER */}
        <View className="flex-row justify-between items-center p-4">
          <TouchableOpacity
            onPress={openDrawer}
            style={{ marginRight: 16 }}
            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
          >
            <Entypo
              name="list"
              size={28}
              color={cs === 'dark' ? '#FFFFFF' : '#000000'}
            />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setIsModalVisible(true)}
            className="flex-row items-center"
            style={{ flex: 1 }}
          >
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className="text-xl font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary"
              style={{ maxWidth: comboModeEnabled && selectedTextModel && selectedImageGenModel ? 200 : 140, opacity: isModelLoading ? 0.5 : 1 }}
            >
              {headerTitle}
            </Text>
            <MaterialIcons
              name="arrow-drop-down"
              size={24}
              color={cs === 'dark' ? '#FFFFFF' : '#000000'}
              style={{ marginLeft: 4 }}
            />
          </TouchableOpacity>

          <TouchableOpacity onPress={handleNewChat} style={{ marginLeft: 12 }}>
            <Ionicons name="create-outline" size={28} color={createColor} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setIsSettingsMenuVisible(!isSettingsMenuVisible)}
            style={{ marginLeft: 12 }}
          >
            <Ionicons
              name="ellipsis-vertical"
              size={24}
              color={cs === 'dark' ? '#FFFFFF' : '#000000'}
            />
          </TouchableOpacity>
        </View>

        {/* Settings pop-over */}
        {isSettingsMenuVisible && (
          <>
            <TouchableOpacity
              onPress={() => setIsSettingsMenuVisible(false)}
              activeOpacity={1}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 10,
              }}
            />
            <View
              style={{
                position: 'absolute',
                top: 60,
                right: 20,
                backgroundColor: cs === 'dark' ? '#333' : '#fff',
                borderRadius: 8,
                padding: 8,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.3,
                shadowRadius: 4,
                zIndex: 11,
              }}
            >
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 6,
                }}
                onPress={() => {
                  setIsSettingsMenuVisible(false);
                  setIsModelSettingsModalVisible(true);
                }}
              >
                <Ionicons
                  name="settings-outline"
                  size={18}
                  color={cs === 'dark' ? '#fff' : '#000'}
                  style={{ marginRight: 8 }}
                />
                <Text style={{ color: cs === 'dark' ? '#fff' : '#000' }}>
                  Gen Settings
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* model / download bars */}
        {isModelLoading && (
          <View className="px-4 mb-2">
            <View className="flex-row items-center">
              <ActivityIndicator size="small" color={spinnerColor} />
              <Text className="ml-2 text-theme-light-text-secondary dark:text-theme-dark-text-secondary">
                Loading model{loadingProgress > 0 ? ` (${loadingProgress}%)` : '...'}
              </Text>
            </View>
            {loadingProgress > 0 && (
              <View style={{ height: 3, backgroundColor: cs === 'dark' ? '#333' : '#DDD', borderRadius: 2, marginTop: 6 }}>
                <View style={{ height: 3, width: `${loadingProgress}%`, backgroundColor: cs === 'dark' ? '#3B82F6' : '#2563EB', borderRadius: 2 }} />
              </View>
            )}
          </View>
        )}
        {loadStatusMsg && !isModelLoading && (
          <View className="px-4 mb-1">
            <Text
              className="text-xs"
              style={{ color: cs === 'dark' ? '#3B82F6' : '#2563EB' }}
            >
              {loadStatusMsg}
            </Text>
          </View>
        )}
        {tokensPerSec !== null && (
          <View className="px-4 mb-1">
            <Text className="text-xs text-theme-light-text-secondary dark:text-theme-dark-text-secondary">
              {tokensPerSec} tokens/sec
            </Text>
          </View>
        )}

        <DownloadProgressHeader cs={cs} />

        {/* Image-gen models get a completely different surface — their own
            view manages the SD pipeline, prompt, and result. All of the
            chat-specific UI below (FlatList, input bar with globe toggle,
            vision attachments) is hidden.
            In combo mode: show ImageGenerationView if ONLY an image model
            is loaded; show chat UI if a text model is loaded (with or
            without image model — the combined experience). */}
        {(() => {
          const showImageView = comboModeEnabled
            ? selectedImageGenModel && !selectedTextModel
            : selectedModel && isImageGenModel(selectedModel);
          const imageModel = comboModeEnabled
            ? selectedImageGenModel
            : selectedModel;
          return showImageView && imageModel;
        })() ? (
          <ImageGenerationView key={imageGenKey} model={(comboModeEnabled ? selectedImageGenModel : selectedModel)!} />
        ) : (
        <>
        {/* chat or placeholder */}
        {!hasMessages ? (
          <View
            style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}
          >
            <Text
              style={{
                fontSize: 24,
                textAlign: 'center',
                color: cs === 'dark' ? '#FFFFFF' : '#000000',
              }}
            >
              What can I help with?
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <ChatList
              flatRef={flatRef}
              renderMsg={renderMsg}
              onScroll={handleListScroll}
              atBottomRef={atBottomRef}
              isAndroid={Platform.OS === 'android'}
            />
            {/* Floating "scroll to bottom" pill — only visible when user has
                scrolled away from the latest message. Mirrors ChatGPT / Claude. */}
            {!atBottom && (
              <TouchableOpacity
                onPress={scrollToBottomNow}
                activeOpacity={0.85}
                style={{
                  position: 'absolute',
                  bottom: 12,
                  alignSelf: 'center',
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: cs === 'dark' ? '#222222' : '#FFFFFF',
                  borderWidth: 1,
                  borderColor: cs === 'dark' ? '#3A3A3A' : '#DADADA',
                  alignItems: 'center',
                  justifyContent: 'center',
                  shadowColor: '#000',
                  shadowOpacity: 0.15,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 4,
                }}
                accessibilityLabel="Scroll to latest message"
              >
                <Ionicons
                  name="arrow-down"
                  size={18}
                  color={cs === 'dark' ? '#FFFFFF' : '#000000'}
                />
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* input bar */}
        <View style={{ backgroundColor: cs === 'dark' ? '#0D0D0D' : '#FCFCFC' }}>
          {/* Image attachment preview */}
          {imageAttachment && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginTop: 8 }}>
              <Image
                source={{ uri: imageAttachment }}
                style={{ width: 60, height: 60, borderRadius: 8 }}
                resizeMode="cover"
              />
              <TouchableOpacity
                onPress={() => setImageAttachment(null)}
                style={{ marginLeft: 8 }}
              >
                <Ionicons name="close-circle" size={22} color="#999" />
              </TouchableOpacity>
            </View>
          )}
          <View
            className="flex-row items-center rounded-[1.9rem] m-4 px-4"
            style={{
              backgroundColor: cs === 'dark' ? '#242424' : '#F0F0F0',
              minHeight: 40,
              height: inputHeight + 16,
              maxHeight: 6 * 40 + 16,
            }}
          >
            {/* Vision image picker button */}
            {isVisionEnabled && (
              <TouchableOpacity
                onPress={handlePickImage}
                className="mr-2 p-2 rounded-full"
                style={{ backgroundColor: imageAttachment ? arrowBg : '#A0A0A0' }}
              >
                <Ionicons
                  name="camera-outline"
                  size={20}
                  color={imageAttachment ? arrowColor : '#666666'}
                />
              </TouchableOpacity>
            )}
            <TextInput
              className="flex-1 text-lg text-theme-light-input-text dark:text-theme-dark-input-text"
              placeholder="Ask anything..."
              placeholderTextColor={placeholderColor}
              multiline
              onContentSizeChange={onInputSizeChange}
              value={inputText}
              onChangeText={setInputText}
              selectionColor="#FFFFFF"
              style={{ paddingVertical: 8, height: inputHeight }}
              keyboardAppearance={cs === 'dark' ? 'dark' : 'light'}
            />

            {/* globe toggle */}
            <TouchableOpacity
              onPress={() => {
                if (!searchEnabled && !firstUseShown.current) {
                  firstUseShown.current = true;
                  themedAlert(
                    'Internet search',
                    'By using the search you agree to the terms and conditions of Google.com.'
                  );
                }
                setSearchEnabled((p) => !p);
              }}
              className="mr-2 p-2 rounded-full"
              style={{ backgroundColor: searchEnabled ? arrowBg : '#A0A0A0' }}
            >
              <Ionicons
                name="globe-outline"
                size={20}
                color={searchEnabled ? arrowColor : '#666666'}
              />
            </TouchableOpacity>

            {/* manual image gen button / loading indicator (combo mode only) */}
            {comboModeEnabled && isImageModelLoading && (
              <View style={{ marginRight: 4, padding: 8 }}>
                <ActivityIndicator size="small" color="#8B5CF6" />
              </View>
            )}
            {comboModeEnabled && isImageModelReady && (
              <TouchableOpacity
                onPress={() => {
                  const text = inputText.trim();
                  if (!text) {
                    themedAlert('Image Prompt', 'Type a description of the image you want to generate.');
                    return;
                  }
                  // Generate image directly from the input text
                  const placeholderId = `manual-img-${Date.now()}`;
                  addChatMessage({
                    id: `img-user-${Date.now()}`,
                    sender: 'User',
                    message: text,
                  });
                  addChatMessage({
                    id: placeholderId,
                    sender: 'Model',
                    message: '',
                    isGeneratingImage: true,
                    imagePrompt: text,
                  });
                  setInputText('');
                  (async () => {
                    try {
                      const base64 = await ImageGenService.generateImage({
                        prompt: text,
                        negativePrompt: genSettings.comboImageNegativePrompt,
                        width: genSettings.comboImageSize,
                        height: genSettings.comboImageSize,
                        steps: genSettings.comboImageSteps,
                        cfgScale: genSettings.comboImageCfgScale,
                      });
                      const uri = await ImageGenService.saveGeneratedImage(base64);
                      updateChatMessage(placeholderId, {
                        isGeneratingImage: false,
                        imageUri: uri,
                        message: '',
                      });
                    } catch (err: any) {
                      updateChatMessage(placeholderId, {
                        isGeneratingImage: false,
                        message: `Failed: ${err?.message ?? 'Unknown error'}`,
                      });
                    }
                  })();
                }}
                className="mr-1 p-2 rounded-full"
                style={{ backgroundColor: '#8B5CF6' }}
              >
                <Ionicons name="image-outline" size={20} color="#FFFFFF" />
              </TouchableOpacity>
            )}

            {/* send / stop */}
            <TouchableOpacity
              onPress={handleSendOrStop}
              disabled={!llamaContext || !selectedModel}
              style={{
                marginLeft: 8,
                padding: 8,
                borderRadius: 999,
                backgroundColor:
                  !llamaContext || !selectedModel ? '#A0A0A0' : arrowBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons
                name={isGenerating ? 'stop' : 'arrow-up'}
                size={20}
                color={!llamaContext || !selectedModel ? '#666666' : arrowColor}
              />
            </TouchableOpacity>
          </View>
        </View>
        </>
        )}
      </Animated.View>
      </KeyboardAvoidingView>

      {/* MODALS */}
      <DownloadModel
        visible={isModalVisible}
        onClose={() => setIsModalVisible(false)}
        onUseModel={(name) => {
          genId.current += 1;
          setIsGenerating(false);
          const m = useStore.getState().models.find((x) => x.name === name);
          if (m) selectModel(m);
          setIsModalVisible(false);
        }}
        onEjectModel={handleEjectModel}
        onDeleteModel={async (name) => {
          // Unload text model context if it's the one being deleted
          const state = useStore.getState();
          if (state.selectedTextModel?.name === name || state.selectedModel?.name === name) {
            if (llamaContextRef.current && !isImageGenModel(state.selectedModel)) {
              await unloadModel();
            }
            selectTextModel(null);
          }
          // Unload image gen model if it's the one being deleted
          if (state.selectedImageGenModel?.name === name) {
            await ImageGenService.unloadImageModel();
            selectImageGenModel(null);
            setIsImageModelReady(false);
          }
        }}
      />

      <ModelSettingsModal
        visible={isModelSettingsModalVisible}
        onClose={() => setIsModelSettingsModalVisible(false)}
        initialSettings={genSettings}
        onSave={setGenSettings}
        thinkingSupported={thinkingSupported}
      />

      {/* drawer overlay & content */}
      <Animated.View
        pointerEvents={drawerOpen ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: '#000',
          opacity: overlayAnim,
        }}
      >
        <TouchableOpacity style={{ flex: 1 }} onPress={closeDrawer} />
      </Animated.View>

      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: dw,
          backgroundColor: cs === 'dark' ? '#0D0D0D' : '#ffffff',
          transform: [{ translateX: drawerAnim }],
        }}
      >
        <ChatSessionsList />
      </Animated.View>
    </SafeAreaView>
  );
};

export default Home;
