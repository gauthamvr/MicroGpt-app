// app/(root)/ProfileDetailPage.tsx

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  useColorScheme,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BACKEND_URL } from '@/constants';
import { useUser } from '@clerk/clerk-expo';
import { useStore } from '@/store';

// This type should match EXACTLY what your store expects for a "PublicCharacter."
type StorePublicCharacter = {
  id: number;
  clerk_id: string;
  name: string;
  subtitle?: string;
  description: string;
  conversation_style: string;
  model_name: string;
  likes_count: number;
  downloads_count: number;
  created_at: string;
  updated_at: string;
};

// Extend your ProfileData type to include "liked_by_current_user"
type ProfileData = {
  user_id: number;
  clerk_id: string;
  username: string;
  display_name: string;
  bio: string;
  user_likes_count: number;
  is_pro: boolean;
  characters: StorePublicCharacter[];
  liked_by_current_user?: boolean; // <--- new
};

export default function ProfileDetailPage() {
  const { username } = useLocalSearchParams<{ username?: string }>();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const { user } = useUser();

  // Store references (same as in chat.tsx)
  const {
    likedPublicCharacters,
    addOrUpdatePublicCharacterAsLocal,
    removeLocalPublicCharacter,
    removeLikedCharacter,
    setEphemeralPublicCharacter,
    setActiveFromEphemeralPublicChar,
  } = useStore();

  const headingColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const cardBgColor = colorScheme === 'dark' ? '#242424' : '#f5f5f5';

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep track of whether the current user has liked THIS user
  const [hasLiked, setHasLiked] = useState(false);

  // 1) Fetch the user data by username
  const fetchUserProfile = async () => {
    if (!username) return;
    setLoading(true);
    try {
      // Pass viewerClerkId in the query string if the user is logged in
      const viewerId = user?.id ?? '';
      const res = await fetch(
        `${BACKEND_URL}/users/username/${username}?viewerClerkId=${viewerId}`
      );
      const data = await res.json();
      if (res.ok && data.data) {
        // data.data has your user info + liked_by_current_user
        setProfile(data.data);
        setHasLiked(!!data.data.liked_by_current_user);
      }
    } catch (err) {
      console.error('Error fetching user by username:', err);
    } finally {
      setLoading(false);
    }
  };

  // Toggle "liking" the user
  const handleToggleLikeUser = async () => {
    if (!username) return;
    if (!user?.id) {
      alert('You must be logged in to like users');
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}/users/${username}/toggle-like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userClerkId: user.id }),
      });
      const data = await res.json();
      if (res.ok) {
        // data.data => the updated user row
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                user_likes_count: data.data.user_likes_count,
              }
            : null
        );
        // data.liked => whether we just liked or unliked
        setHasLiked(data.liked);
      }
    } catch (err) {
      console.error('Error toggling user like:', err);
    }
  };

  // CHARACTER: determine if char is liked
  const isCharLiked = (charId: number) => {
    return likedPublicCharacters.some((c) => c.id === charId);
  };

  const handleToggleLikeCharacter = async (char: StorePublicCharacter) => {
    if (!user?.id) {
      Alert.alert('Not logged in', 'You must be logged in to like characters.');
      return;
    }
    try {
      const res = await fetch(
        `${BACKEND_URL}/publicCharacters/${char.id}/toggle-like`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userClerkId: user.id }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        // Refresh the profile so the updated likes_count shows
        fetchUserProfile();

        // If just liked => add to local store
        if (data.liked === true && data.data) {
          const updatedChar = data.data; // backend returns the updated row
          addOrUpdatePublicCharacterAsLocal({
            id: updatedChar.id,
            clerk_id: updatedChar.clerk_id,
            name: updatedChar.name,
            subtitle: updatedChar.subtitle,
            description: updatedChar.description,
            conversation_style: updatedChar.conversation_style,
            model_name: updatedChar.model_name,
            likes_count: updatedChar.likes_count,
            downloads_count: updatedChar.downloads_count,
            created_at: updatedChar.created_at,
            updated_at: updatedChar.updated_at,
          });
        }

        // If unliked => remove from store
        if (data.liked === false && data.data) {
          removeLikedCharacter(char.id);
          removeLocalPublicCharacter(char.id);
        }
      } else {
        console.error('Error toggling like:', data.error);
      }
    } catch (err) {
      console.error('Error toggling like character:', err);
    }
  };

  // CHARACTER: load ephemeral
  const handlePressCharacter = async (char: StorePublicCharacter) => {
    try {
      await fetch(
        `${BACKEND_URL}/publicCharacters/${char.id}/increment-download`,
        {
          method: 'POST',
        }
      );
    } catch (error) {
      console.error('Error incrementing download:', error);
    }

    setEphemeralPublicCharacter({ ...char });
    setActiveFromEphemeralPublicChar();

    const st = useStore.getState();
    if (st.activeCharacter) {
      router.push('/(root)/(tabs)/home');
    }
  };

  useEffect(() => {
    fetchUserProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  // If there's no username param, show a fallback
  if (!username) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#000' : '#fff',
        }}
      >
        <Text style={{ color: headingColor }}>No username provided.</Text>
      </SafeAreaView>
    );
  }

  // If loading, show a spinner
  if (loading) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#000' : '#fff',
        }}
      >
        <ActivityIndicator size="large" color="#888" />
      </SafeAreaView>
    );
  }

  // If fetched but no profile found, show error
  if (!profile) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#000' : '#fff',
        }}
      >
        <Text style={{ color: headingColor }}>
          This user doesn't exist or an error occurred.
        </Text>
      </SafeAreaView>
    );
  }

  // Render each public character
  const renderCharItem = ({ item }: { item: StorePublicCharacter }) => {
    const liked = isCharLiked(item.id);
    return (
      <View
        style={{
          backgroundColor: cardBgColor,
          marginBottom: 8,
          padding: 12,
          borderRadius: 8,
        }}
      >
        {/* Top row: name + heart icon */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text
            style={{
              color: headingColor,
              fontWeight: 'bold',
              marginBottom: 4,
              fontSize: 16,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {item.name}
          </Text>

          <TouchableOpacity
            onPress={() => handleToggleLikeCharacter(item)}
            style={{ marginLeft: 10 }}
          >
            <Ionicons
              name={liked ? 'heart' : 'heart-outline'}
              size={20}
              color="#f44336"
            />
          </TouchableOpacity>
        </View>

        {/* Optional subtitle */}
        {item.subtitle ? (
          <Text style={{ color: '#777', marginBottom: 4 }}>
            {item.subtitle}
          </Text>
        ) : null}

        {/* likes / downloads row + arrow to load */}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Ionicons
            name="heart"
            size={16}
            color="#f44336"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 16 }}>
            {item.likes_count}
          </Text>

          <Ionicons
            name="download"
            size={16}
            color="#3f51b5"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 16 }}>
            {item.downloads_count}
          </Text>

          {/* Load ephemeral */}
          <TouchableOpacity
            onPress={() => handlePressCharacter(item)}
            style={{
              marginLeft: 'auto',
              paddingHorizontal: 6,
              paddingVertical: 4,
            }}
          >
            <Ionicons
              name="arrow-forward-circle-outline"
              size={20}
              color={headingColor}
            />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#ffffff',
        paddingHorizontal: 16,
        paddingTop: 8,
      }}
    >
      {/* Centered user info */}
      <View style={{ alignItems: 'center', marginTop: 20 }}>
        <Text
          style={{
            color: headingColor,
            fontSize: 20,
            fontWeight: 'bold',
            marginBottom: 4,
          }}
        >
          {profile.display_name}
        </Text>
        <Text
          style={{
            color: headingColor,
            fontSize: 16,
            marginBottom: 8,
          }}
        >
          @{profile.username}
        </Text>

        {/* Likes count + "like user" heart */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
          }}
        >
          <Text
            style={{
              color: headingColor,
              marginRight: 8,
              fontSize: 16,
            }}
          >
            Likes: {profile.user_likes_count}
          </Text>
          <TouchableOpacity onPress={handleToggleLikeUser}>
            <Ionicons
              name="heart"
              size={24}
              color={hasLiked ? '#f44336' : '#999'}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Bio (if any) */}
      {profile.bio ? (
        <Text
          style={{
            marginBottom: 16,
            color: headingColor,
            textAlign: 'center',
            paddingHorizontal: 10,
          }}
        >
          {profile.bio}
        </Text>
      ) : null}

      {/* List of public characters */}
      <Text
        style={{
          marginTop: 10,
          fontSize: 16,
          fontWeight: 'bold',
          color: headingColor,
          marginBottom: 10,
          textAlign: 'center',
        }}
      >
        Public Characters
      </Text>

      {profile.characters && profile.characters.length > 0 ? (
        <FlatList
          data={profile.characters}
          renderItem={renderCharItem}
          keyExtractor={(item) => item.id.toString()}
        />
      ) : (
        <Text style={{ color: headingColor, textAlign: 'center' }}>
          No published characters
        </Text>
      )}
    </SafeAreaView>
  );
}
