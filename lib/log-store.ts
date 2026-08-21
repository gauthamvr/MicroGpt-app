// lib/log-store.ts
//
// In-app log capture so users can share what they're seeing without
// needing developer mode + adb. We patch console.log / warn / error
// once at module load and tee everything into a fixed-size ring
// buffer. The original console methods still run normally — Metro /
// adb logcat output doesn't change in dev — so this is purely additive.
//
// Memory cost: ring buffer of MAX_ENTRIES strings (default 500). Each
// entry is the formatted message + a tiny header (timestamp, level).
// Even at 200 chars/entry that's ~100 KB, well under the noise floor.
//
// Performance cost: one Array.push + one shift when full, per console
// call. Negligible relative to the underlying I/O the original methods
// already do. Patching happens once.

const MAX_ENTRIES = 500;

export type LogLevel = 'log' | 'warn' | 'error' | 'info';
export type LogEntry = {
  ts: number;     // Date.now()
  level: LogLevel;
  message: string;
};

// IMPORTANT: `entries` is replaced atomically on every push, NEVER
// mutated in place. `getLogEntries` returns it directly so its
// reference stays stable between pushes — that's required by
// `useSyncExternalStore`, which renders in an infinite loop if the
// snapshot reference changes on every call (the bug we shipped on
// 2026-05-03 that crashed the app on launch).
let entries: readonly LogEntry[] = [];
const subscribers = new Set<() => void>();
let installed = false;

function notify() {
  for (const cb of subscribers) {
    try { cb(); } catch {}
  }
}

function format(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function push(level: LogLevel, args: unknown[]) {
  const message = args.map(format).join(' ');
  const next: LogEntry = { ts: Date.now(), level, message };
  // Always replace the array — never mutate. Slicing keeps the
  // newest MAX_ENTRIES entries when the buffer is full.
  entries = entries.length >= MAX_ENTRIES
    ? [...entries.slice(1), next]
    : [...entries, next];
  notify();
}

/**
 * Install console patches. Idempotent — calling twice is a no-op.
 * Safe to invoke from the app entry point on every render; the guard
 * inside ensures we only wrap once.
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  // Keep references to the originals so the patched versions can
  // still emit to Metro / adb / browser devtools.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origInfo = console.info?.bind(console) ?? origLog;

  console.log = (...args: unknown[]) => { push('log', args); origLog(...args); };
  console.info = (...args: unknown[]) => { push('info', args); origInfo(...args); };
  console.warn = (...args: unknown[]) => { push('warn', args); origWarn(...args); };
  console.error = (...args: unknown[]) => { push('error', args); origError(...args); };

  push('log', [`[log-store] capture installed (max ${MAX_ENTRIES} entries)`]);
}

// Returns the live entries array directly. The contract: callers must
// NOT mutate it (it's typed `readonly`). The reference is stable until
// the next push() or clearLogs(), which atomically replaces it. That
// stability is what lets `useSyncExternalStore` avoid an infinite
// re-render loop — `Object.is(prev, next)` returns true between
// pushes, so React only re-renders when there's actually a change.
export function getLogEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLogs(): void {
  entries = [];
  notify();
}

/**
 * Subscribe to log changes. Returns an unsubscribe function. Use this
 * from React components via `useSyncExternalStore` so the UI updates
 * incrementally as new lines stream in (without re-rendering on every
 * keystroke or unrelated state change).
 */
export function subscribeLogs(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/**
 * Format the ring buffer as plain text for sharing — one line per
 * entry, ISO timestamp + level + message. Used by the in-app log
 * viewer's "copy" / "share" actions.
 */
export function formatLogsForShare(): string {
  return entries
    .map((e) => {
      const t = new Date(e.ts).toISOString();
      const lvl = e.level.toUpperCase().padEnd(5, ' ');
      return `${t} ${lvl} ${e.message}`;
    })
    .join('\n');
}
