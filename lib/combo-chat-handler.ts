// lib/combo-chat-handler.ts
//
// Combo mode stream processor: detects [IMG: ...] tags in the LLM's
// streaming output, strips them from visible text, and triggers image
// generation via the shared image-gen-service. This keeps home.tsx
// from growing further.

import { parseImageTags } from './image-tag-parser';
import * as ImageGenService from './image-gen-service';

export type ComboImageSettings = {
  steps: number;
  cfgScale: number;
  imageSize: number;
  negativePrompt: string;
};

export type ComboStreamCallbacks = {
  /** Called whenever visible text (tags stripped) should be shown to the user */
  onVisibleTextUpdate: (text: string) => void;
  /** Called when an [IMG: ...] tag is detected — show a placeholder in chat */
  onImageGenerationStart: (prompt: string, placeholderId: string) => void;
  /** Called when image generation completes — insert the image into chat */
  onImageGenerationComplete: (placeholderId: string, imageUri: string) => void;
  /** Called if image generation fails */
  onImageGenerationError: (placeholderId: string, error: string) => void;
};

export type ComboStreamProcessor = {
  /** Feed each token chunk from the LLM stream */
  feedToken: (token: string) => void;
  /** Call when the stream ends to flush any remaining buffer */
  finalize: () => void;
  /** Cancel any pending image generations */
  cancel: () => void;
};

/**
 * Create a combo stream processor that intercepts LLM output,
 * detects image tags, and orchestrates image generation.
 */
export function createComboStreamProcessor(
  callbacks: ComboStreamCallbacks,
  imageSettings?: ComboImageSettings,
): ComboStreamProcessor {
  let buffer = '';
  let cancelled = false;
  // Track prompts we've already dispatched to avoid double-triggering
  const dispatchedPrompts = new Set<string>();
  let pendingGenerations = 0;

  function processBuffer(isFinal: boolean) {
    const parsed = parseImageTags(buffer);

    // If there's a pending (partial) tag at the end and we're still
    // streaming, hold back — the tag might still be forming.
    if (parsed.pendingTag && !isFinal) {
      // Show text up to the partial tag opening bracket
      const bracketIdx = buffer.lastIndexOf('[');
      if (bracketIdx > 0) {
        callbacks.onVisibleTextUpdate(parseImageTags(buffer.slice(0, bracketIdx)).visibleText);
      }
      return;
    }

    // Update visible text (tags stripped)
    callbacks.onVisibleTextUpdate(parsed.visibleText);

    // Trigger image generation for any new prompts
    for (const prompt of parsed.imagePrompts) {
      // Deduplicate — same prompt appearing in the buffer shouldn't
      // trigger generation twice
      const key = prompt.slice(0, 100);
      if (dispatchedPrompts.has(key)) continue;
      dispatchedPrompts.add(key);

      const placeholderId = `combo-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      callbacks.onImageGenerationStart(prompt, placeholderId);
      pendingGenerations++;

      // Fire-and-forget image generation
      (async () => {
        if (cancelled) return;
        try {
          const defaults = ImageGenService.pickDefaults(
            ImageGenService.getLoadedModelName() ?? '',
          );
          const base64 = await ImageGenService.generateImage({
            prompt,
            negativePrompt: imageSettings?.negativePrompt,
            width: imageSettings?.imageSize ?? 256,
            height: imageSettings?.imageSize ?? 256,
            steps: imageSettings?.steps ?? defaults.steps,
            cfgScale: imageSettings?.cfgScale ?? defaults.cfg,
          });
          if (cancelled) return;
          const uri = await ImageGenService.saveGeneratedImage(base64);
          callbacks.onImageGenerationComplete(placeholderId, uri);
        } catch (err: any) {
          if (!cancelled) {
            callbacks.onImageGenerationError(
              placeholderId,
              err?.message ?? 'Image generation failed',
            );
          }
        } finally {
          pendingGenerations--;
        }
      })();
    }
  }

  return {
    feedToken(token: string) {
      if (cancelled) return;
      buffer += token;
      processBuffer(false);
    },

    finalize() {
      if (cancelled) return;
      processBuffer(true);
    },

    cancel() {
      cancelled = true;
      if (pendingGenerations > 0) {
        ImageGenService.cancelGeneration().catch(() => {});
      }
    },
  };
}
