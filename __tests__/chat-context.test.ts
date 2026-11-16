import { buildHistoryMessages, estimateTokens, selectHistoryWindow } from '../lib/chat-context';
import type { ChatMessage } from '../store/useChatSessionsSlice';

let nextId = 0;
const user = (message: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${nextId++}`,
  sender: 'User',
  message,
  ...extra,
});
const model = (message: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${nextId++}`,
  sender: 'Model',
  message,
  ...extra,
});

describe('buildHistoryMessages', () => {
  test('maps senders to roles in order', () => {
    expect(buildHistoryMessages([user('hi'), model('hello'), user('how are you?')])).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you?' },
    ]);
  });

  test('replaces a past user image with a text marker', () => {
    expect(
      buildHistoryMessages([
        user('what is this?', { imageUri: 'file:///a.png' }),
        user('(image)', { imageUri: 'file:///b.png' }),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: '[Image attached previously] what is this?\n[Image attached previously]',
      },
    ]);
  });

  test('drops empty replies and keeps roles alternating', () => {
    const history = [
      user('draw a cat'),
      model('Here you go!'),
      model('', { imageUri: 'file:///cat.png', imagePrompt: 'a cat' }),
      user('thanks'),
      model(''),
      user('are you there?'),
    ];
    expect(buildHistoryMessages(history)).toEqual([
      { role: 'user', content: 'draw a cat' },
      { role: 'assistant', content: 'Here you go!' },
      { role: 'user', content: 'thanks\nare you there?' },
    ]);
  });
});

describe('selectHistoryWindow', () => {
  // 40 characters = 10 tokens per message.
  const text = (n: number) => `message ${String(n).padStart(2, '0')} `.padEnd(40, 'x');
  const chat = (count: number): ChatMessage[] =>
    Array.from({ length: count }, (_, i) => (i % 2 === 0 ? user(text(i)) : model(text(i))));

  test('estimates about four characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('keeps the whole history while it fits', () => {
    const history = chat(6);
    const result = selectHistoryWindow(history, 20, 100, null);
    expect(result.messages).toHaveLength(6);
    expect(result.startId).toBeNull();
  });

  test('cuts below the budget, not just to it', () => {
    const history = chat(20); // 200 tokens of history
    const result = selectHistoryWindow(history, 0, 100, null);
    // Target is 60% of the budget: 6 messages.
    expect(result.messages).toHaveLength(6);
    expect(result.startId).toBe(history[14].id);
  });

  test('holds the cut on later turns until the budget is exceeded again', () => {
    const history = chat(20);
    const first = selectHistoryWindow(history, 0, 100, null);

    // Two more turns: 10 messages = 100 tokens, still within budget.
    history.push(user(text(20)), model(text(21)), user(text(22)), model(text(23)));
    const second = selectHistoryWindow(history, 0, 100, first.startId);
    expect(second.startId).toBe(first.startId);
    expect(second.messages).toHaveLength(10);
    expect(second.messages[0].content).toBe(first.messages[0].content);

    // One more turn tips it over: cut again, further along.
    history.push(user(text(24)), model(text(25)));
    const third = selectHistoryWindow(history, 0, 100, second.startId);
    expect(third.startId).toBe(history[20].id);
    expect(third.messages).toHaveLength(6);
  });

  test('counts the rest of the prompt against the budget', () => {
    const history = chat(10); // 100 tokens
    expect(selectHistoryWindow(history, 0, 100, null).messages).toHaveLength(10);
    expect(selectHistoryWindow(history, 30, 100, null).messages).toHaveLength(3);
  });

  test('always keeps the last two messages', () => {
    const history = chat(8);
    const result = selectHistoryWindow(history, 500, 100, null);
    expect(result.messages).toHaveLength(2);
    expect(result.startId).toBe(history[6].id);
  });

  test('ignores a start id from another chat', () => {
    const history = chat(4);
    const result = selectHistoryWindow(history, 0, 100, 'not-in-this-chat');
    expect(result.messages).toHaveLength(4);
    expect(result.startId).toBeNull();
  });

  test('handles an empty history', () => {
    expect(selectHistoryWindow([], 10, 100, null)).toEqual({ messages: [], startId: null });
  });
});
