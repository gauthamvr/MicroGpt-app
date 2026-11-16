// lib/chub-api.ts
// Chub.ai API client + format converter for MicroGPT characters

import { checkCharacterText } from './content-safety';

const CHUB_API = 'https://api.chub.ai';

export type ChubSearchResult = {
  id: number;
  name: string;
  fullPath: string;
  description: string;
  tagline: string;
  starCount: number;
  nTokens: number;
  nChats: number;
  avatar_url: string;
  topics: string[];
};

export type ChubCharacterDefinition = {
  name: string;
  personality: string;
  tavern_personality: string;
  scenario: string;
  first_message: string;
  example_dialogs: string;
  system_prompt: string;
  post_history_instructions?: string;
  description: string;
  avatar: string;
};

export async function searchChubCharacters(
  query: string,
  page: number = 1,
  count: number = 20
): Promise<{ nodes: ChubSearchResult[]; totalCount: number }> {
  const params = new URLSearchParams({
    search: query,
    first: String(count),
    page: String(page),
    namespace: 'characters',
    sort: 'download_count',
    asc: 'false',
    nsfw: 'false',
    nsfl: 'false',
  });

  const res = await fetch(`${CHUB_API}/search?${params.toString()}`);
  if (!res.ok) throw new Error(`Chub search failed: ${res.status}`);
  const json = await res.json();
  const nodes: ChubSearchResult[] = json.data?.nodes || [];
  return {
    nodes: nodes.filter(isSafeCharacter),
    totalCount: json.data?.count || 0,
  };
}

// Chub's nsfw=false relies on creators tagging their own cards, so
// results are screened again here on topics and visible text.
const ADULT_TOPICS = new Set([
  'nsfw', 'nsfl', 'lewd', 'smut', 'erotic', 'erotica', 'sexual', 'sex',
  'fetish', 'kink', 'kinky', 'hentai', 'porn', 'ntr', 'netorare', 'breeding',
  'futa', 'futanari', 'bdsm', 'incest', 'loli', 'shota', 'nude', 'naked',
]);

function isSafeCharacter(node: ChubSearchResult): boolean {
  if ((node.topics || []).some((t) => ADULT_TOPICS.has(t.trim().toLowerCase()))) {
    return false;
  }
  const text = [node.name, node.tagline, node.description].filter(Boolean).join('\n');
  return checkCharacterText(text).allowed;
}

/**
 * Fetch popular characters (no search query) for default browsing.
 */
export async function getPopularChubCharacters(
  count: number = 20
): Promise<ChubSearchResult[]> {
  const data = await searchChubCharacters('', 1, count);
  return data.nodes;
}

export async function fetchChubCharacter(
  fullPath: string
): Promise<ChubCharacterDefinition> {
  const res = await fetch(
    `${CHUB_API}/api/characters/${fullPath}?full=true`
  );
  if (!res.ok) throw new Error(`Chub fetch failed: ${res.status}`);
  const json = await res.json();
  const def = json.node?.definition;
  if (!def) throw new Error('Character definition not found');
  return def;
}

/**
 * Convert a Chub character to MicroGPT format, optimized for small LLMs.
 * Keeps total system prompt under ~500 tokens (~1750 chars).
 *
 * Preserves these Character Card V2 fields separately so the chat code
 * can inject them into the right parts of the prompt:
 *   - description         → # Character section
 *   - scenario            → # Scenario section (previously lost — it was
 *                            stored only as subtitle for UI display)
 *   - conversationStyle   → # Example dialog section (if real examples)
 *   - systemPrompt        → overrides our hardcoded rules when present
 *   - postHistoryInstructions → overrides our hardcoded "Reminder" when present
 *   - firstMessage        → seeded as the first assistant message
 */
export function convertChubToMicroGPT(
  def: ChubCharacterDefinition & {
    post_history_instructions?: string;
  },
  modelName: string
) {
  const name = (def.name || 'Unknown').trim().slice(0, 100);

  // Use tavern_personality (short) if available, otherwise truncate personality
  const rawPersonality = def.tavern_personality || def.personality || '';
  const description = truncateText(rawPersonality, 500);

  // Build a concise conversation style from example_dialogs.
  // No fake filler — if the card has no real examples, we return an empty
  // string and the system prompt skips that section entirely.
  const conversationStyle = compactExamples(def.example_dialogs || '', name);

  // Scenario is its own section (and also displayed as subtitle).
  const scenario = truncateText(def.scenario || '', 400);
  const subtitle = truncateText(def.scenario || '', 200);

  // Creator-supplied overrides (most cards leave these blank)
  const systemPrompt = truncateText(def.system_prompt || '', 600);
  const postHistoryInstructions = truncateText(
    def.post_history_instructions || '',
    300,
  );

  return {
    name,
    subtitle,
    description,
    scenario,
    conversationStyle,
    modelName,
    firstMessage: (def.first_message || '').trim().slice(0, 1000),
    systemPrompt,
    postHistoryInstructions,
  };
}

function truncateText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\{\{char\}\}/gi, 'Character')
    .replace(/\{\{user\}\}/gi, 'User')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  // Cut at last sentence boundary within limit
  const truncated = cleaned.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxChars * 0.5) return truncated.slice(0, lastPeriod + 1);
  return truncated + '...';
}

function compactExamples(rawExamples: string, charName: string): string {
  // If there are no real examples from chub, return an empty string —
  // do NOT fabricate placeholder dialog. Generic filler like "I'd be
  // happy to share!" actively HURTS roleplay quality on small models
  // because it teaches the model to break character with bland phrases.
  if (!rawExamples.trim()) return '';

  // Clean up Chub template variables
  const cleaned = rawExamples
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, 'User')
    .replace(/<START>/gi, '')
    .trim();

  // Split into exchanges and take first 3 at most
  const exchanges = cleaned.split(/\n\n+/).filter(e => e.trim().length > 0);
  const selected = exchanges.slice(0, 3);

  // Format and cap total length to keep system prompt under control
  let result = selected.join('\n\n');
  if (result.length > 800) {
    result = result.slice(0, 800);
    const lastNewline = result.lastIndexOf('\n\n');
    if (lastNewline > 200) result = result.slice(0, lastNewline);
  }

  return result;
}
