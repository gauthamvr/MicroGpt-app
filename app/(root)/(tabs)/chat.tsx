// app/(root)/(tabs)/chat.tsx

import React, { useState, useCallback } from 'react';
import {
  Text,
  View,
  TouchableOpacity,
  FlatList,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '@/lib/supabase';
import { useRouter } from 'expo-router';
import { useStore } from '@/store';
import { useFocusEffect } from '@react-navigation/native';
import {
  getPublicAndLiked,
  toggleCharacterLike,
  incrementDownload,
} from '@/lib/supabase-api';
import ChubBrowserModal from '@/components/ChubBrowserModal';
import { promptReport } from '@/lib/content-report';

const Characters = () => {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const { user } = useAuth();

  const headingColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const cardBgColor = colorScheme === 'dark' ? '#242424' : '#f5f5f5';

  // For the sort button colors
  const activeBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const activeText = colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  const inactiveBg = colorScheme === 'dark' ? '#666666' : '#CCCCCC';
  const inactiveText = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  // Per-field selectors so this tab doesn't re-render on every
  // chatHistory update while the user is streaming on Home. Bottom-tab
  // screens stay mounted after first visit, so a bare useStore() here
  // was re-rendering this screen ~20×/sec during long generations.
  const likedPublicCharacters = useStore((s) => s.likedPublicCharacters);
  const setLikedCharacters = useStore((s) => s.setLikedCharacters);
  const ephemeralPublicCharacter = useStore((s) => s.ephemeralPublicCharacter);
  const setEphemeralPublicCharacter = useStore((s) => s.setEphemeralPublicCharacter);
  const setActiveFromEphemeralPublicChar = useStore((s) => s.setActiveFromEphemeralPublicChar);
  const addOrUpdatePublicCharacterAsLocal = useStore((s) => s.addOrUpdatePublicCharacterAsLocal);
  const removeLocalPublicCharacter = useStore((s) => s.removeLocalPublicCharacter);
  const removeLikedCharacter = useStore((s) => s.removeLikedCharacter);
  const hiddenPublicCharacterIds = useStore((s) => s.hiddenPublicCharacterIds);
  const hidePublicCharacter = useStore((s) => s.hidePublicCharacter);

  const [sortBy, setSortBy] = useState<'likes' | 'downloads'>('likes');
  const [publicChars, setPublicChars] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [showChubBrowser, setShowChubBrowser] = useState(false);

  // -------------------------
  // Single fetch to get public + liked
  // -------------------------
  const fetchPublicAndLiked = async () => {
    try {
      const data = await getPublicAndLiked(sortBy);
      setPublicChars(data.publicChars || []);
      setLikedCharacters(data.likedChars || []);
    } catch (error) {
      if (__DEV__) console.error('fetchPublicAndLiked error:', error);
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
      themedAlert('Not logged in', 'You must be logged in to like characters.');
      return;
    }
    try {
      const result = await toggleCharacterLike(charId);
      const updatedChar = result.data;
      const justLiked = result.liked === true;

      // 1) Update local "likedPublicCharacters" list
      if (justLiked) {
        const oldLiked = useStore.getState().likedPublicCharacters;
        setLikedCharacters([...oldLiked, updatedChar]);
      } else {
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
          user_id: updatedChar.user_id,
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
        removeLocalPublicCharacter(charId);
      }
    } catch (error) {
      if (__DEV__) console.error('handleToggleLike error:', error);
    }
  };

  // Increment "download" count
  const handleIncrementDownload = async (charId: number) => {
    try {
      const result = await incrementDownload(charId);
      const updatedChar = result.data;
      setPublicChars((prev) =>
        prev.map((pc) =>
          pc.id === charId
            ? { ...pc, downloads_count: updatedChar.downloads_count }
            : pc
        )
      );
    } catch (error) {
      if (__DEV__) console.error('handleIncrementDownload error:', error);
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
            onPress={() =>
              promptReport(
                {
                  contentType: 'character',
                  characterId: item.id,
                  modelName: item.model_name,
                  contentExcerpt: `#${item.id} ${item.name}\n${item.subtitle ?? ''}\n${item.description ?? ''}`,
                },
                () => hidePublicCharacter(item.id),
              )
            }
            accessibilityLabel="Report character"
            style={{
              marginLeft: 'auto',
              padding: 6,
            }}
          >
            <Ionicons
              name="flag-outline"
              size={18}
              color={colorScheme === 'dark' ? '#9BA1A6' : '#666'}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => handleToggleLike(item.id)}
            style={{
              marginLeft: 4,
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
      <View className="px-4 pt-3" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text
          style={{
            fontSize: 18,
            fontWeight: 'bold',
            color: headingColor,
          }}
        >
          Public Characters
        </Text>
        <TouchableOpacity
          onPress={() => setShowChubBrowser(true)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: colorScheme === 'dark' ? '#242424' : '#f5f5f5',
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Ionicons name="compass-outline" size={16} color={headingColor} style={{ marginRight: 4 }} />
          <Text style={{ color: headingColor, fontSize: 13, fontWeight: '600' }}>
            Discover More
          </Text>
        </TouchableOpacity>
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
        data={publicChars.filter((c) => !hiddenPublicCharacterIds.includes(c.id))}
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

      {/* Chub.ai Character Browser */}
      <ChubBrowserModal
        visible={showChubBrowser}
        onClose={() => setShowChubBrowser(false)}
      />
    </SafeAreaView>
  );
};

export default Characters;
