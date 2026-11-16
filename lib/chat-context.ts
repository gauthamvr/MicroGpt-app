// lib/chat-context.ts
//
// Turns the stored chat into the history messages sent to the model.

import type { ChatMessage } from '@/store/useChatSessionsSlice';

export type HistoryMessage = { role: 'user' | 'assistant'; content: string };

/** After a cut, history is trimmed down to this share of the budget. */
const TRIM_TARGET = 0.6;

/** Rough token count: ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Stored messages as prompt messages, oldest first.
 *
 *  - Old images are not re-encoded: the vision encoder is expensive and the
 *    reply about the image is already in the history, so a past user image
 *    becomes a short text marker.
 *  - Messages without text (generated-image bubbles, failed replies) are
 *    dropped, and neighbours left with the same role are merged, so roles
 *    always alternate. Several chat templates reject anything else.
 */
export function buildHistoryMessages(history: ChatMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of history) {
    let content = m.message;
    if (m.sender === 'User' && m.imageUri) {
      const text = m.message && m.message !== '(image)' ? m.message : '';
      content = text ? `[Image attached previously] ${text}` : '[Image attached previously]';
    }
    if (!content.trim()) continue;
    const role = m.sender === 'User' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  return out;
}

/**
 * Pick the part of `history` that goes into the prompt.
 *
 * `fixedTokens` is what the rest of the prompt costs (system prompt, web
 * context, the new user message); history gets what is left of
 * `budgetTokens`.
 *
 * Dropping one message per turn would move the start of the history on
 * every turn once a chat outgrows the budget, and every move makes the
 * model re-evaluate the whole prompt instead of reusing its KV cache. So a
 * cut goes further than needed (down to TRIM_TARGET of the budget) and the
 * caller passes the returned `startId` back in on the next turn, which
 * keeps the same starting message for as long as the history still fits.
 *
 * The last two stored messages are always kept, even when over budget.
 */
export function selectHistoryWindow(
  history: ChatMessage[],
  fixedTokens: number,
  budgetTokens: number,
  prevStartId: string | null,
): { messages: HistoryMessage[]; startId: string | null } {
  const cost = (msgs: HistoryMessage[]) =>
    fixedTokens + msgs.reduce((n, m) => n + estimateTokens(m.content), 0);

  const prevStart = prevStartId ? history.findIndex((m) => m.id === prevStartId) : -1;
  let start = Math.max(prevStart, 0);
  let messages = buildHistoryMessages(history.slice(start));

  if (cost(messages) > budgetTokens) {
    const lastStart = Math.max(start, history.length - 2);
    const target = budgetTokens * TRIM_TARGET;
    while (start < lastStart && cost(messages) > target) {
      start += 1;
      messages = buildHistoryMessages(history.slice(start));
    }
  }

  return { messages, startId: start > 0 ? history[start].id : null };
}
