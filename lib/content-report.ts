// lib/content-report.ts
//
// In-app reporting of AI-generated content. Google Play's AI-Generated
// Content policy requires that users can flag offensive output to the
// developer without leaving the app. Reports are inserted into the
// Supabase `content_reports` table (insert-only for clients — see
// supabase-migration-content-reports.sql). The app is offline-first, so
// a report that can't be sent is queued in AsyncStorage and retried on
// the next report and on app start.

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { themedAlert } from '@/components/ThemedAlert';

export type ReportReason = 'sexual' | 'violent_hateful' | 'other';

export type ReportInput = {
  contentType: 'image' | 'chat' | 'character';
  modelName?: string | null;
  /** The prompt that produced the content (image prompt or user turn). */
  prompt?: string | null;
  /** The reported text itself (chat replies). Images are never uploaded. */
  contentExcerpt?: string | null;
  /** public_characters.id of a reported community character. */
  characterId?: number | null;
};

type ReportRow = {
  content_type: 'image' | 'chat' | 'character';
  reason: ReportReason;
  character_id: number | null;
  model_name: string | null;
  prompt: string | null;
  content_excerpt: string | null;
  platform: string;
  app_version: string | null;
};

const QUEUE_KEY = 'pendingContentReports';
const CONTENT_NOUN = { image: 'image', chat: 'reply', character: 'character' } as const;
const MAX_QUEUED = 50;

function clip(s: string | null | undefined, max: number): string | null {
  const t = (s ?? '').trim();
  return t ? t.slice(0, max) : null;
}

function toRow(input: ReportInput, reason: ReportReason): ReportRow {
  return {
    content_type: input.contentType,
    reason,
    character_id: input.characterId ?? null,
    model_name: clip(input.modelName, 200),
    prompt: clip(input.prompt, 2000),
    content_excerpt: clip(input.contentExcerpt, 4000),
    platform: Platform.OS,
    app_version: clip(Constants.expoConfig?.version, 50),
  };
}

async function readQueue(): Promise<ReportRow[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeQueue(rows: ReportRow[]): Promise<void> {
  try {
    if (rows.length === 0) await AsyncStorage.removeItem(QUEUE_KEY);
    else await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(rows.slice(-MAX_QUEUED)));
  } catch {}
}

async function insertRows(rows: ReportRow[]): Promise<boolean> {
  try {
    const { error } = await supabase.from('content_reports').insert(rows);
    if (error) console.warn('[content-report] insert failed:', error.message);
    return !error;
  } catch (err: any) {
    console.warn('[content-report] insert failed:', err?.message ?? err);
    return false;
  }
}

/** Send any reports queued while offline. Safe to call any time. */
export async function flushPendingReports(): Promise<void> {
  const queued = await readQueue();
  if (queued.length === 0) return;
  if (await insertRows(queued)) await writeQueue([]);
}

/** Returns 'sent', or 'queued' when the report will be retried later. */
export async function submitReport(
  input: ReportInput,
  reason: ReportReason,
): Promise<'sent' | 'queued'> {
  const row = toRow(input, reason);
  const queued = await readQueue();
  if (await insertRows([...queued, row])) {
    if (queued.length > 0) await writeQueue([]);
    return 'sent';
  }
  await writeQueue([...queued, row]);
  return 'queued';
}

/**
 * Ask the user why they're reporting, send the report, and confirm.
 * `onReported` runs after a report is filed (sent or queued) so the
 * caller can hide the reported content.
 */
export function promptReport(input: ReportInput, onReported?: () => void): void {
  const send = async (reason: ReportReason) => {
    const result = await submitReport(input, reason);
    onReported?.();
    themedAlert(
      'Thanks for reporting',
      result === 'sent'
        ? 'Your report was sent to the MicroGPT developer and will be used to improve the content filters.'
        : "You're offline, so your report will be sent automatically once you're back online.",
    );
  };
  themedAlert(
    'Report this content',
    `Why are you reporting this ${CONTENT_NOUN[input.contentType]}? Reports go to the MicroGPT developer.`,
    [
      { text: 'Sexual or explicit', onPress: () => void send('sexual') },
      { text: 'Violent or hateful', onPress: () => void send('violent_hateful') },
      { text: 'Something else', onPress: () => void send('other') },
      { text: 'Cancel', style: 'cancel' },
    ],
  );
}
