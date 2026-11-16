-- ============================================================
-- Migration: Content Reports (2026-10-06)
--
-- Run this once in the Supabase SQL Editor on your already-deployed
-- project. Safe to re-run — all statements are idempotent.
--
-- Google Play's AI-Generated Content policy requires an in-app way for
-- users to report offensive AI output to the developer without leaving
-- the app, and the UGC policy requires the same for community
-- characters. The app inserts one row per report (lib/content-report.ts).
--
-- Anyone (signed in or not) may INSERT. Nobody can read rows through
-- the API — there is deliberately no SELECT policy, so reports are only
-- visible to the project owner (dashboard / service role).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.content_reports (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image', 'chat', 'character')),
  reason TEXT NOT NULL CHECK (reason IN ('sexual', 'violent_hateful', 'other')),
  model_name TEXT CHECK (char_length(model_name) <= 200),
  prompt TEXT CHECK (char_length(prompt) <= 2000),
  content_excerpt TEXT CHECK (char_length(content_excerpt) <= 4000),
  platform TEXT CHECK (char_length(platform) <= 20),
  app_version TEXT CHECK (char_length(app_version) <= 50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.content_reports DROP CONSTRAINT IF EXISTS content_reports_content_type_check;
ALTER TABLE public.content_reports ADD CONSTRAINT content_reports_content_type_check
  CHECK (content_type IN ('image', 'chat', 'character'));

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can file a content report" ON public.content_reports;
CREATE POLICY "Anyone can file a content report"
  ON public.content_reports FOR INSERT
  TO anon, authenticated
  WITH CHECK (user_id IS NULL OR user_id = (SELECT auth.uid()));

-- ─── Character reports (2026-10-15) ─────────────────────────────────
-- Which community character was reported, and who published it, so
-- reports can be grouped per character and per author. No foreign keys
-- on purpose: the ids must outlive a deleted character or account.
-- reported_user_id is filled from public_characters by the trigger, so
-- a client can't attribute a report to the wrong author.

ALTER TABLE public.content_reports ADD COLUMN IF NOT EXISTS character_id INT;
ALTER TABLE public.content_reports ADD COLUMN IF NOT EXISTS reported_user_id UUID;

CREATE OR REPLACE FUNCTION public.fill_content_report_author()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.reported_user_id := NULL;
  IF NEW.character_id IS NOT NULL THEN
    SELECT user_id INTO NEW.reported_user_id
      FROM public.public_characters
      WHERE id = NEW.character_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_content_report_author_trigger ON public.content_reports;
CREATE TRIGGER fill_content_report_author_trigger
  BEFORE INSERT ON public.content_reports
  FOR EACH ROW EXECUTE FUNCTION public.fill_content_report_author();
