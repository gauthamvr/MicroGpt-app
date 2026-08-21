// lib/hf-url.ts
//
// Tiny shared helpers for parsing HuggingFace URLs. The same regex
// was inlined in two components and we wanted it on a third (the
// suggested model list), so consolidating into one source of truth.

/**
 * Extract `<owner>/<repo>` from a HuggingFace URL.
 *
 * Handles the typical resolve / blob / tree shapes:
 *   https://huggingface.co/Chun121/Qwen3-4B-RPG-Roleplay-V2/resolve/main/foo.gguf
 *   https://huggingface.co/ggml-org/SmolVLM-256M-Instruct-GGUF/blob/main/foo.gguf
 *   https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/tree/main
 *
 * Returns null if the URL doesn't look like a HuggingFace model URL.
 */
export function repoFromHfUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const m = url.match(/huggingface\.co\/([^\/]+\/[^\/]+)(?:\/|$)/i);
  if (!m) return null;
  // Skip hub sub-routes like /datasets, /spaces — they share the same
  // pattern but aren't model repos.
  const reserved = new Set([
    'datasets', 'spaces', 'models', 'docs', 'organizations', 'settings',
    'pricing', 'login', 'join', 'blog', 'posts', 'enterprise', 'api',
    'chat', 'new', 'tasks', 'events', 'search', 'collections', 'papers',
    'tools', 'privacy', 'terms',
  ]);
  const owner = m[1].split('/')[0];
  if (reserved.has(owner.toLowerCase())) return null;
  return m[1];
}
