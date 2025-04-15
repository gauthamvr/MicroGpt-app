// app/(root)/(tabs)/chat.tsx

import React, { useState, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  FlatList,
  Alert,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useUser } from '@clerk/clerk-expo';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { BACKEND_URL } from '@/constants';
import { useFocusEffect } from '@react-navigation/native';

const BASE_URL = BACKEND_URL;

const Characters = () => {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const { user } = useUser();

  const headingColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const cardBgColor = colorScheme === 'dark' ? '#242424' : '#f5f5f5';

  // For the sort button colors
  const activeBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const activeText = colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  const inactiveBg = colorScheme === 'dark' ? '#666666' : '#CCCCCC';
  const inactiveText = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  const {
    likedPublicCharacters,
    setLikedCharacters,
    ephemeralPublicCharacter,
    setEphemeralPublicCharacter,
    setActiveFromEphemeralPublicChar,
    addOrUpdatePublicCharacterAsLocal,
    removeLocalPublicCharacter,
    removeLikedCharacter,
  } = useStore();

  const [sortBy, setSortBy] = useState<'likes' | 'downloads'>('likes');
  const [publicChars, setPublicChars] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // -------------------------
  // Single fetch to get public + liked
  // -------------------------
  const fetchPublicAndLiked = async () => {
    try {
      const userClerkId = user?.id || '';
      const queryParams = `?sortBy=${sortBy}${
        userClerkId ? `&userClerkId=${userClerkId}` : ''
      }`;
      const response = await fetch(`${BASE_URL}/publicAndLiked${queryParams}`);
      const data = await response.json();
      if (response.ok) {
        // data = { publicChars, likedChars }
        setPublicChars(data.publicChars);
        setLikedCharacters(data.likedChars || []);
      } else {
        console.error('Failed fetching /publicAndLiked:', data.error);
      }
    } catch (error) {
      console.error('fetchPublicAndLiked error:', error);
    }
  };

  // Only fetch when screen is focused or sort changes
  useFocusEffect(
    useCallback(() => {
      fetchPublicAndLiked();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortBy])
  );

  // Pull-to-refresh
  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchPublicAndLiked();
    setRefreshing(false);
  };

  // Check if a character is liked locally
  const isCharLiked = (charId: number): boolean => {
    return likedPublicCharacters.some((c) => c.id === charId);
  };

  // Toggle "like" with an optimistic update
  const handleToggleLike = async (charId: number) => {
    if (!user?.id) {
      Alert.alert('Not logged in', 'You must be logged in to like characters.');
      return;
    }
    try {
      // Call toggle endpoint
      const res = await fetch(
        `${BASE_URL}/publicCharacters/${charId}/toggle-like`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userClerkId: user.id }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        // data = { data: updatedChar, liked: boolean }
        const updatedChar = data.data;
        const justLiked = data.liked === true;

        // 1) Update local "likedPublicCharacters" list
        if (justLiked) {
          // Add to local liked
          const oldLiked = useStore.getState().likedPublicCharacters;
          setLikedCharacters([...oldLiked, updatedChar]);
        } else {
          // Remove from local liked
          removeLikedCharacter(charId);
        }

        // 2) Update local "publicChars" array for the updated character
        setPublicChars((prev) =>
          prev.map((pc) => {
            if (pc.id === charId) {
              return {
                ...pc,
                likes_count: updatedChar.likes_count,
              };
            }
            return pc;
          })
        );

        // 3) If newly liked, add to local store
        if (justLiked) {
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
        } else {
          // If just unliked, remove from store
          removeLocalPublicCharacter(charId);
        }
      } else {
        console.error('Error toggling like:', data.error);
      }
    } catch (error) {
      console.error('handleToggleLike error:', error);
    }
  };

  // Increment "download" count on server
  const handleIncrementDownload = async (charId: number) => {
    try {
      const res = await fetch(
        `${BASE_URL}/publicCharacters/${charId}/increment-download`,
        {
          method: 'POST',
        }
      );
      const data = await res.json();
      if (!res.ok) {
        console.error('Error incrementing download:', data.error);
      } else {
        // optional: update local publicChars
        const updatedChar = data.data;
        setPublicChars((prev) =>
          prev.map((pc) =>
            pc.id === charId
              ? { ...pc, downloads_count: updatedChar.downloads_count }
              : pc
          )
        );
      }
    } catch (error) {
      console.error('handleIncrementDownload error:', error);
    }
  };

  // When user taps a specific character
  const handlePressCharacter = async (item: any) => {
    // Mark a download
    await handleIncrementDownload(item.id);

    // Set ephemeral
    setEphemeralPublicCharacter(item);
    // Attempt load
    setActiveFromEphemeralPublicChar();

    // If successfully loaded, go home
    const st = useStore.getState();
    if (st.activeCharacter) {
      router.push('/(root)/(tabs)/home');
    }
  };

  // Navigate to profile detail by passing the username
  const handlePressUsername = (username: string) => {
    router.push({
      pathname: '/(root)/ProfileDetailPage',
      params: { username },
    });
  };

  // Rendering each character row
  const renderItem = ({ item }: { item: any }) => {
    const isLiked = isCharLiked(item.id);
    const charUsername = item.username || 'unknown';

    return (
      <View
        className="rounded-lg p-4 mb-2"
        style={{
          backgroundColor: cardBgColor,
        }}
      >
        {/* Top row: Name + heart (like) icon */}
        <View className="flex-row items-center justify-between mb-1">
          <Text
            style={{
              fontSize: 16,
              fontWeight: 'bold',
              color: headingColor,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {item.name}
          </Text>

          <TouchableOpacity
            onPress={() => handleToggleLike(item.id)}
            style={{
              marginLeft: 8,
              padding: 6,
            }}
          >
            <Ionicons
              name={isLiked ? 'heart' : 'heart-outline'}
              size={20}
              color="#f44336"
            />
          </TouchableOpacity>
        </View>

        {/* Subtitle */}
        {item.subtitle ? (
          <Text
            style={{
              marginBottom: 8,
              color: colorScheme === 'dark' ? '#9BA1A6' : '#666',
            }}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {item.subtitle}
          </Text>
        ) : null}

        {/* Row with likes & downloads, plus the @username with pro badge */}
        <View className="flex-row items-center">
          <Ionicons
            name="heart"
            size={16}
            color="#f44336"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 16 }}>
            {item.likes_count || 0}
          </Text>

          <Ionicons
            name="download"
            size={16}
            color="#3f51b5"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 16 }}>
            {item.downloads_count || 0}
          </Text>

          {/* Show @username, clickable, with pro badge if applicable */}
          <TouchableOpacity
            onPress={() => handlePressUsername(charUsername)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                color: headingColor,
                textDecorationLine: 'underline',
              }}
            >
              @{charUsername}
            </Text>
            {item.is_pro && (
              <MaterialIcons
                name="verified"
                size={16}
                color="#1DA1F2"
                style={{ marginLeft: 4 }}
              />
            )}
          </TouchableOpacity>

          {/* (Tap ">" icon to load ephemeral) */}
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
      className={`flex-1 ${
        colorScheme === 'dark'
          ? 'bg-theme-dark-background'
          : 'bg-theme-light-background'
      }`}
    >
      {/* Header */}
      <View className="px-4 pt-3">
        <Text
          style={{
            fontSize: 18,
            fontWeight: 'bold',
            color: headingColor,
          }}
        >
          Public Characters
        </Text>
      </View>

      {/* Sort By Buttons */}
      <View className="flex-row mt-2 ml-4">
        <TouchableOpacity
          className="rounded-lg mr-2"
          style={{
            padding: 8,
            backgroundColor: sortBy === 'likes' ? activeBg : inactiveBg,
          }}
          onPress={() => setSortBy('likes')}
        >
          <Text
            style={{
              color: sortBy === 'likes' ? activeText : inactiveText,
            }}
          >
            Sort by Likes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          className="rounded-lg"
          style={{
            padding: 8,
            backgroundColor: sortBy === 'downloads' ? activeBg : inactiveBg,
          }}
          onPress={() => setSortBy('downloads')}
        >
          <Text
            style={{
              color: sortBy === 'downloads' ? activeText : inactiveText,
            }}
          >
            Sort by Downloads
          </Text>
        </TouchableOpacity>
      </View>

      {/* List */}
      <FlatList
        data={publicChars}
        renderItem={renderItem}
        keyExtractor={(item) => item.id.toString()}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 16,
          marginTop: 8,
        }}
        // Pull-to-refresh
        onRefresh={handleRefresh}
        refreshing={refreshing}
      />
    </SafeAreaView>
  );
};

export default Characters;
