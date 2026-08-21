// lib/supabase-api.ts
// Replaces all fetchAPI calls to the Express server with direct Supabase client calls.

import { supabase } from './supabase';

// --- User Management ---

export async function createUserProfile(data: {
  name: string;
  email: string;
  username: string;
  displayName: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: result, error } = await supabase
    .from('users')
    .insert({
      user_id: user.id,
      name: data.name,
      email: data.email,
      username: data.username,
      display_name: data.displayName,
    })
    .select()
    .single();

  if (error) throw error;
  return result;
}

export async function updateUserProfile(updates: {
  username?: string;
  display_name?: string;
  bio?: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: result, error } = await supabase
    .from('users')
    .update(updates)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) throw error;
  return result;
}

export async function getProfileBundle() {
  const { data, error } = await supabase.rpc('get_profile_bundle');
  if (error) throw error;
  return data; // { dbUser, published, liked }
}

// --- Public Profile ---

export async function getProfileByUsername(username: string) {
  const { data, error } = await supabase.rpc('get_profile_by_username', {
    p_username: username,
  });
  if (error) throw error;
  return data; // { user_id, username, display_name, bio, user_likes_count, is_pro, liked_by_current_user, characters }
}

// --- Likes ---

export async function toggleUserLike(username: string) {
  const { data, error } = await supabase.rpc('toggle_user_like', {
    p_username: username,
  });
  if (error) throw error;
  return data; // { liked, data: { id, username, display_name, bio, is_pro, user_likes_count } }
}

export async function toggleCharacterLike(characterId: number) {
  const { data, error } = await supabase.rpc('toggle_character_like', {
    p_character_id: characterId,
  });
  if (error) throw error;
  return data; // { liked, data: { ...character fields } }
}

// --- Characters ---

export async function getPublicAndLiked(sortBy: string = 'likes') {
  const { data, error } = await supabase.rpc('get_public_and_liked', {
    p_sort_by: sortBy,
  });
  if (error) throw error;
  return data; // { publicChars, likedChars }
}

export async function createPublicCharacter(charData: {
  name: string;
  subtitle: string;
  description: string;
  conversationStyle: string;
  modelName: string;
}) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('public_characters')
    .insert({
      user_id: user.id,
      name: charData.name,
      subtitle: charData.subtitle,
      description: charData.description,
      conversation_style: charData.conversationStyle,
      model_name: charData.modelName,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updatePublicCharacter(
  characterId: number,
  charData: {
    name: string;
    subtitle: string;
    description: string;
    conversationStyle: string;
    modelName: string;
  }
) {
  const { data, error } = await supabase
    .from('public_characters')
    .update({
      name: charData.name,
      subtitle: charData.subtitle,
      description: charData.description,
      conversation_style: charData.conversationStyle,
      model_name: charData.modelName,
      updated_at: new Date().toISOString(),
    })
    .eq('id', characterId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deletePublicCharacter(characterId: number) {
  const { error } = await supabase
    .from('public_characters')
    .delete()
    .eq('id', characterId);

  if (error) throw error;
}

export async function deleteOwnAccount() {
  const { error } = await supabase.rpc('delete_own_account');
  if (error) throw error;
}

export async function incrementDownload(characterId: number) {
  const { data, error } = await supabase.rpc('increment_download', {
    p_character_id: characterId,
  });
  if (error) throw error;
  return data; // { data: { id, name, downloads_count } }
}
