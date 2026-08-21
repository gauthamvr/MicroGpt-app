-- ============================================================
-- Supabase Setup SQL for MicroGPT
-- Run this in the Supabase SQL Editor after creating your project
-- ============================================================

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  is_pro BOOLEAN DEFAULT FALSE,
  user_likes_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.public_characters (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  conversation_style TEXT NOT NULL,
  model_name TEXT NOT NULL,
  likes_count INT DEFAULT 0,
  downloads_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.user_likes (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  character_id INT REFERENCES public.public_characters(id) ON DELETE CASCADE NOT NULL,
  PRIMARY KEY (user_id, character_id)
);

CREATE TABLE public.user_likes_users (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  liked_user_id INT REFERENCES public.users(id) ON DELETE CASCADE NOT NULL,
  PRIMARY KEY (user_id, liked_user_id)
);

-- Tracks which users have already bumped a character's download counter.
-- The PRIMARY KEY makes increment_download() idempotent per (user, character):
-- a loop of RPC calls from one account resolves to a single counter bump.
CREATE TABLE public.character_downloads (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  character_id INT REFERENCES public.public_characters(id) ON DELETE CASCADE NOT NULL,
  downloaded_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, character_id)
);

-- ============================================================
-- 2. ROW LEVEL SECURITY POLICIES
-- ============================================================

-- USERS TABLE
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable by everyone"
  ON public.users FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE POLICY "Users can create own profile"
  ON public.users FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- PUBLIC_CHARACTERS TABLE
ALTER TABLE public.public_characters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public characters are viewable by everyone"
  ON public.public_characters FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE POLICY "Users can create own characters"
  ON public.public_characters FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own characters"
  ON public.public_characters FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own characters"
  ON public.public_characters FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- USER_LIKES TABLE
ALTER TABLE public.user_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own likes"
  ON public.user_likes FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create own likes"
  ON public.user_likes FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own likes"
  ON public.user_likes FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- USER_LIKES_USERS TABLE
ALTER TABLE public.user_likes_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own user likes"
  ON public.user_likes_users FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can create own user likes"
  ON public.user_likes_users FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own user likes"
  ON public.user_likes_users FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- CHARACTER_DOWNLOADS TABLE — only readable by the owner; all writes
-- happen inside the increment_download() SECURITY DEFINER function,
-- never from the client directly. No INSERT/UPDATE/DELETE policies on
-- purpose; user-initiated writes are blocked by RLS.
ALTER TABLE public.character_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own downloads"
  ON public.character_downloads FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- ============================================================
-- 2a. COUNTER-FREEZE TRIGGERS
-- ------------------------------------------------------------
-- RLS lets a user UPDATE their own row, but doesn't restrict which
-- COLUMNS they can update. Without these triggers a user could PATCH
-- their own public_characters row with likes_count = 999999 via a
-- direct REST call and bypass the toggle_character_like RPC.
--
-- The triggers pin the counter columns to their OLD values on every
-- UPDATE, unless a SECURITY DEFINER RPC has explicitly set the
-- transaction-local flag `app.counter_update_allowed` to 'true' —
-- which only our own functions do.
-- ============================================================

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

-- ============================================================
-- 3. POSTGRES FUNCTIONS (RPC)
-- ============================================================

-- TOGGLE CHARACTER LIKE (atomic like/unlike + counter update)
CREATE OR REPLACE FUNCTION toggle_character_like(p_character_id INT)
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

  -- Allow the counter UPDATE through the freeze_character_counters trigger.
  -- Transaction-local (`is_local = true`), so it auto-clears at commit.
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

-- TOGGLE USER LIKE (atomic like/unlike + counter update)
CREATE OR REPLACE FUNCTION toggle_user_like(p_username TEXT)
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

  -- Allow the counter UPDATE through the freeze_user_counters trigger.
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

-- INCREMENT DOWNLOAD COUNT
-- Idempotent per (user, character): the unique PK on character_downloads
-- turns repeat calls from the same account into no-ops at the INSERT
-- step, so a looping client can't inflate the counter.
CREATE OR REPLACE FUNCTION increment_download(p_character_id INT)
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

  -- First-download check: rely on the PK conflict to rate-limit
  INSERT INTO character_downloads (user_id, character_id)
  VALUES (v_user_id, p_character_id)
  ON CONFLICT (user_id, character_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  IF v_inserted_count > 0 THEN
    -- First time this user has downloaded this character — bump the counter.
    -- The transaction-local flag lets the counter UPDATE through the
    -- freeze_character_counters trigger.
    PERFORM set_config('app.counter_update_allowed', 'true', true);

    UPDATE public_characters
    SET downloads_count = downloads_count + 1
    WHERE id = p_character_id
    RETURNING id, name, downloads_count INTO v_character;
  ELSE
    -- Repeat call from the same user — return current stats unchanged.
    SELECT id, name, downloads_count INTO v_character
    FROM public_characters WHERE id = p_character_id;
  END IF;

  IF v_character.id IS NULL THEN
    RAISE EXCEPTION 'Character not found';
  END IF;

  RETURN json_build_object('data', row_to_json(v_character));
END;
$$;

-- GET PROFILE BY USERNAME (with characters + liked_by_current_user)
CREATE OR REPLACE FUNCTION get_profile_by_username(p_username TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_result JSON;
BEGIN
  SELECT json_build_object(
    'user_id', u.id,
    'username', u.username,
    'display_name', u.display_name,
    'bio', u.bio,
    'user_likes_count', u.user_likes_count,
    'is_pro', u.is_pro,
    'liked_by_current_user', CASE
      WHEN v_user_id IS NULL THEN false
      ELSE EXISTS(
        SELECT 1 FROM user_likes_users ulu
        WHERE ulu.liked_user_id = u.id AND ulu.user_id = v_user_id
      )
    END,
    'characters', COALESCE(
      (SELECT json_agg(json_build_object(
        'id', c.id,
        'user_id', c.user_id,
        'name', c.name,
        'subtitle', c.subtitle,
        'description', c.description,
        'conversation_style', c.conversation_style,
        'model_name', c.model_name,
        'likes_count', c.likes_count,
        'downloads_count', c.downloads_count,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      ))
      FROM public_characters c WHERE c.user_id = u.user_id),
      '[]'::json
    )
  ) INTO v_result
  FROM users u
  WHERE u.username = p_username;

  RETURN v_result;
END;
$$;

-- GET PUBLIC CHARACTERS + USER'S LIKED CHARS
CREATE OR REPLACE FUNCTION get_public_and_liked(p_sort_by TEXT DEFAULT 'likes')
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_public_chars JSON;
  v_liked_chars JSON;
  v_order TEXT;
BEGIN
  IF p_sort_by = 'downloads' THEN
    v_order := 'downloads_count';
  ELSE
    v_order := 'likes_count';
  END IF;

  EXECUTE format(
    'SELECT COALESCE(json_agg(t ORDER BY t.%I DESC), ''[]''::json) FROM (
      SELECT pc.*, u.username, u.is_pro
      FROM public_characters pc
      LEFT JOIN users u ON pc.user_id = u.user_id
      ORDER BY pc.%I DESC
      LIMIT 20
    ) t', v_order, v_order
  ) INTO v_public_chars;

  IF v_user_id IS NOT NULL THEN
    SELECT COALESCE(json_agg(c), '[]'::json)
    INTO v_liked_chars
    FROM public_characters c
    JOIN user_likes ul ON c.id = ul.character_id
    WHERE ul.user_id = v_user_id;
  ELSE
    v_liked_chars := '[]'::json;
  END IF;

  RETURN json_build_object(
    'publicChars', v_public_chars,
    'likedChars', v_liked_chars
  );
END;
$$;

-- DELETE OWN ACCOUNT (cascades to all user data)
CREATE OR REPLACE FUNCTION delete_own_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Delete from public.users (cascades to public_characters, user_likes, user_likes_users)
  DELETE FROM public.users WHERE user_id = v_user_id;

  -- Delete the auth account itself
  DELETE FROM auth.users WHERE id = v_user_id;
END;
$$;

-- GET PROFILE BUNDLE (own profile + published + liked chars)
CREATE OR REPLACE FUNCTION get_profile_bundle()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_db_user JSON;
  v_published JSON;
  v_liked JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT row_to_json(u) INTO v_db_user
  FROM (
    SELECT id, name, email, user_id, username, display_name, bio, is_pro, user_likes_count
    FROM users WHERE user_id = v_user_id LIMIT 1
  ) u;

  SELECT COALESCE(json_agg(c ORDER BY c.updated_at DESC), '[]'::json) INTO v_published
  FROM public_characters c
  WHERE c.user_id = v_user_id;

  SELECT COALESCE(json_agg(c ORDER BY c.likes_count DESC), '[]'::json) INTO v_liked
  FROM public_characters c
  JOIN user_likes ul ON c.id = ul.character_id
  WHERE ul.user_id = v_user_id;

  RETURN json_build_object(
    'dbUser', v_db_user,
    'published', v_published,
    'liked', v_liked
  );
END;
$$;
