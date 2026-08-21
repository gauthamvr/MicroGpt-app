-- ============================================================
-- Migration: Counter Integrity (2026-04-19)
--
-- Run this once in the Supabase SQL Editor on your already-deployed
-- project. Safe to re-run — all statements are idempotent.
--
-- Fixes two abuse vectors surfaced in the security review:
--   1. increment_download() could be called in a loop by any
--      authenticated user, inflating downloads_count arbitrarily.
--   2. The "Users can update own characters/profile" RLS policies
--      didn't restrict WHICH columns a user could update, so a
--      direct PATCH via the REST API could bump likes_count /
--      downloads_count / user_likes_count on a row the user owns.
--
-- Approach:
--   - Track (user_id, character_id) first-time downloads in a new
--     table; rely on PRIMARY KEY to make increment_download idempotent.
--   - Install BEFORE UPDATE triggers on public_characters and users
--     that pin the counter columns to their OLD values unless a
--     transaction-local flag is set. Our SECURITY DEFINER functions
--     set the flag explicitly; direct user UPDATEs never do.
-- ============================================================

-- (1) Downloads tracking table --------------------------------

CREATE TABLE IF NOT EXISTS public.character_downloads (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  character_id INT REFERENCES public.public_characters(id) ON DELETE CASCADE NOT NULL,
  downloaded_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id)
);

ALTER TABLE public.character_downloads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own downloads" ON public.character_downloads;
CREATE POLICY "Users can view own downloads"
  ON public.character_downloads FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Intentionally no INSERT / UPDATE / DELETE policies — writes go
-- through increment_download() (SECURITY DEFINER) only.


-- (2) Counter-freeze triggers ---------------------------------

CREATE OR REPLACE FUNCTION public.freeze_character_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.counter_update_allowed', true) = 'true' THEN
    RETURN NEW;
  END IF;
  NEW.likes_count := OLD.likes_count;
  NEW.downloads_count := OLD.downloads_count;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS freeze_character_counters_trigger ON public.public_characters;
CREATE TRIGGER freeze_character_counters_trigger
  BEFORE UPDATE ON public.public_characters
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_character_counters();

CREATE OR REPLACE FUNCTION public.freeze_user_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.counter_update_allowed', true) = 'true' THEN
    RETURN NEW;
  END IF;
  NEW.user_likes_count := OLD.user_likes_count;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS freeze_user_counters_trigger ON public.users;
CREATE TRIGGER freeze_user_counters_trigger
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_user_counters();


-- (3) Updated RPCs (set the bypass flag before touching counters) -----

CREATE OR REPLACE FUNCTION public.toggle_character_like(p_character_id INT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_exists BOOLEAN;
  v_liked BOOLEAN;
  v_character public_characters%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM user_likes
    WHERE user_id = v_user_id AND character_id = p_character_id
  ) INTO v_exists;

  PERFORM set_config('app.counter_update_allowed', 'true', true);

  IF v_exists THEN
    DELETE FROM user_likes
    WHERE user_id = v_user_id AND character_id = p_character_id;

    UPDATE public_characters
    SET likes_count = GREATEST(likes_count - 1, 0)
    WHERE id = p_character_id
    RETURNING * INTO v_character;

    v_liked := FALSE;
  ELSE
    INSERT INTO user_likes (user_id, character_id)
    VALUES (v_user_id, p_character_id);

    UPDATE public_characters
    SET likes_count = likes_count + 1
    WHERE id = p_character_id
    RETURNING * INTO v_character;

    v_liked := TRUE;
  END IF;

  RETURN json_build_object(
    'liked', v_liked,
    'data', row_to_json(v_character)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.toggle_user_like(p_username TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_liked_user_id INT;
  v_exists BOOLEAN;
  v_liked BOOLEAN;
  v_updated_user RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT id INTO v_liked_user_id
  FROM users WHERE username = p_username LIMIT 1;

  IF v_liked_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM user_likes_users
    WHERE user_id = v_user_id AND liked_user_id = v_liked_user_id
  ) INTO v_exists;

  PERFORM set_config('app.counter_update_allowed', 'true', true);

  IF v_exists THEN
    DELETE FROM user_likes_users
    WHERE user_id = v_user_id AND liked_user_id = v_liked_user_id;

    UPDATE users SET user_likes_count = GREATEST(user_likes_count - 1, 0)
    WHERE id = v_liked_user_id
    RETURNING id, username, display_name, bio, is_pro, user_likes_count
    INTO v_updated_user;

    v_liked := FALSE;
  ELSE
    INSERT INTO user_likes_users (user_id, liked_user_id)
    VALUES (v_user_id, v_liked_user_id);

    UPDATE users SET user_likes_count = user_likes_count + 1
    WHERE id = v_liked_user_id
    RETURNING id, username, display_name, bio, is_pro, user_likes_count
    INTO v_updated_user;

    v_liked := TRUE;
  END IF;

  RETURN json_build_object(
    'liked', v_liked,
    'data', row_to_json(v_updated_user)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_download(p_character_id INT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_character RECORD;
  v_inserted_count INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  INSERT INTO character_downloads (user_id, character_id)
  VALUES (v_user_id, p_character_id)
  ON CONFLICT (user_id, character_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  IF v_inserted_count > 0 THEN
    PERFORM set_config('app.counter_update_allowed', 'true', true);

    UPDATE public_characters
    SET downloads_count = downloads_count + 1
    WHERE id = p_character_id
    RETURNING id, name, downloads_count INTO v_character;
  ELSE
    SELECT id, name, downloads_count INTO v_character
    FROM public_characters WHERE id = p_character_id;
  END IF;

  IF v_character.id IS NULL THEN
    RAISE EXCEPTION 'Character not found';
  END IF;

  RETURN json_build_object('data', row_to_json(v_character));
END;
$$;
