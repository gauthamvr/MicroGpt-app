// lib/image-tag-parser.ts
//
// Parses [IMG: description] tags from text model streaming output.
// Used by combo mode to detect when a character wants to "send a photo"
// and extract the image prompt for Stable Diffusion generation.
//
// Lenient matching: small local models (1-3B) are unreliable with exact
// formatting, so we also accept [image: ...], [PHOTO: ...], [photo: ...].

export type ParseResult = {
  /** Text content with all [IMG: ...] tags removed */
  visibleText: string;
  /** Extracted image prompts, in order of appearance */
  imagePrompts: string[];
  /** True if a partial tag is detected at the end (still streaming) */
  pendingTag: boolean;
};

// Match [IMG: ...], [image: ...], [PHOTO: ...] (case-insensitive tag name)
const TAG_RE = /\[(IMG|image|PHOTO|photo|Image|Photo):\s*([^\]]+)\]/g;

// Detect a partial tag at the end of the buffer (still being streamed)
const PARTIAL_TAG_RE = /\[(IMG|image|PHOTO|photo|Image|Photo)(:\s*[^\]]*)?$/i;

/**
 * Parse image tags from accumulated text.
 *
 * Returns the visible text (tags stripped), any extracted image prompts,
 * and whether a partial tag is forming at the end of the buffer.
 */
export function parseImageTags(rawText: string): ParseResult {
  const imagePrompts: string[] = [];

  // Check for partial tag at the end BEFORE stripping complete tags
  const pendingTag = PARTIAL_TAG_RE.test(rawText);

  // Extract complete tags
  let visibleText = rawText.replace(TAG_RE, (_match, _tagName, description) => {
    const trimmed = description.trim();
    if (trimmed) imagePrompts.push(trimmed);
    return ''; // Remove the tag from visible text
  });

  // Clean up any double-spaces or leading/trailing whitespace left by removal
  visibleText = visibleText.replace(/  +/g, ' ');

  return { visibleText, imagePrompts, pendingTag };
}

/**
 * Lightweight check: does the text contain any complete image tags?
 */
export function hasImageTags(text: string): boolean {
  TAG_RE.lastIndex = 0;
  return TAG_RE.test(text);
}
