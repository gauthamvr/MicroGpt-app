// app/(root)/(tabs)/profile.tsx

import React, { useState, useEffect } from 'react';
import { useUser, useClerk } from '@clerk/clerk-expo';
import {
  Image,
  ScrollView,
  Text,
  TouchableOpacity,
  Alert,
  View,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { MaterialIcons } from '@expo/vector-icons';
import { useStore } from '@/store';
import CreateOrEditCharacterModal from '@/components/CreateOrEditCharacterModal';
import DownloadModel from '@/components/DownloadModel';
import { BACKEND_URL } from '@/constants';

// NEW imports
import ProfileEditModal from '@/components/ProfileEditModal';
import BecomeProModal from '@/components/BecomeProModal';

const BASE_URL = BACKEND_URL;

// 1) Add a short-timeout helper so fetch won't hang too long
function fetchWithTimeout(
  resource: string,
  options: RequestInit = {},
  timeout = 2000
) {
  return Promise.race([
    fetch(resource, options),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeout)
    ),
  ]);
}

const Profile = () => {
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const colorScheme = useColorScheme();

  const headingColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const cardBgColor = colorScheme === 'dark' ? '#242424' : '#f5f5f5';

  const {
    characters,
    deleteCharacter,
    downloadedModels,
    setActiveCharacter,
    setLikedCharacters,
    removeLikedCharacter,
    updateCharacter,
    removeLocalPublicCharacter,
    resetAllUserData,
    // remove: loadUserPublishedCharacters
  } = useStore();

  const [isCharModalVisible, setIsCharModalVisible] = useState(false);
  const [editCharacter, setEditCharacter] = useState<any>(null);
  const [showDownloadModalForCharId, setShowDownloadModalForCharId] = useState<
    string | null
  >(null);

  // track if user is loading from DB, store user object
  const [dbUser, setDbUser] = useState<any>(null);
  const [loadingDbUser, setLoadingDbUser] = useState<boolean>(false);

  const [showProfileEditModal, setShowProfileEditModal] =
    useState<boolean>(false);
  const [showBecomeProModal, setShowBecomeProModal] = useState<boolean>(false);

  // Clerk user info
  const clerkId = user?.id;
  // const avatarUrl = { uri: user?.imageUrl ?? '' };
  const avatarUrl = require('@/assets/images/icon.png');

  // Single "fetchProfileBundle" call
  const fetchProfileBundle = async (theClerkId: string) => {
    setLoadingDbUser(true);
    try {
      const res = await fetchWithTimeout(
        `${BASE_URL}/profileBundle/${theClerkId}`,
        {},
        3000 // e.g. 5 second timeout
      );
      const data = await res.json();
      if (res.ok) {
        // data => { dbUser, published, liked }
        setDbUser(data.dbUser);

        // 1) Merge "published" into local store
        // We'll replicate your old "loadUserPublishedCharacters" logic:
        const publishedChars = data.published || [];
        // We'll unify them with local store
        // create or update them as read/write
        useStore.setState((s: any) => {
          const newChars = [...s.characters];
          for (const pubChar of publishedChars) {
            const existingIndex = newChars.findIndex(
              (c: any) => c.publicId === pubChar.id
            );
            const base = {
              name: pubChar.name,
              subtitle: pubChar.subtitle ?? '',
              modelName: pubChar.model_name,
              description: pubChar.description,
              conversationStyle: pubChar.conversation_style,
              publicId: pubChar.id,
              isReadOnly: false,
              likes_count: pubChar.likes_count,
              downloads_count: pubChar.downloads_count,
            };
            if (existingIndex >= 0) {
              newChars[existingIndex] = {
                ...newChars[existingIndex],
                ...base,
              };
            } else {
              newChars.push({
                id: Date.now().toString(),
                ...base,
              });
            }
          }
          return { characters: newChars };
        });

        // 2) Set "liked" in store
        const likedChars = data.liked || [];
        setLikedCharacters(likedChars);
      }
    } catch (error) {
      console.error('fetchProfileBundle error:', error);
    } finally {
      setLoadingDbUser(false);
    }
  };

  // On sign in, do a single "profileBundle" call
  useEffect(() => {
    if (!clerkId) return;
    fetchProfileBundle(clerkId);
  }, [clerkId]);

  const handleSignOut = async () => {
    try {
      await signOut();
      resetAllUserData();
      router.replace('/(root)/(tabs)/home');
    } catch (error: any) {
      console.error('Sign out error:', error);
    }
  };

  const confirmSignOut = () => {
    Alert.alert(
      'Confirm Logout',
      'All unsaved data will be lost once logged out. Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Logout', style: 'destructive', onPress: handleSignOut },
      ]
    );
  };

  const openCreateModal = () => {
    setEditCharacter(null);
    setIsCharModalVisible(true);
  };

  const openEditModal = (charId: string) => {
    const found = characters.find((c) => c.id === charId);
    if (found) {
      setEditCharacter(found);
      setIsCharModalVisible(true);
    }
  };

  const handleDelete = (charId: string) => {
    Alert.alert(
      'Confirm Delete',
      'Are you sure you want to delete this character?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const found = characters.find((c) => c.id === charId);
            if (found?.publicId) {
              try {
                await fetch(`${BASE_URL}/publicCharacters/${found.publicId}`, {
                  method: 'DELETE',
                });
              } catch (err) {
                console.error('Failed to delete from server', err);
              }
            }
            deleteCharacter(charId);
          },
        },
      ]
    );
  };

  const handleSelectCharacter = (charId: string) => {
    const char = characters.find((c) => c.id === charId);
    if (!char) return;
    setActiveCharacter(charId);
    const st = useStore.getState();
    if (!st.activeCharacter) {
      return;
    }
    router.push('/(root)/(tabs)/home');
  };

  // "Unlike" is already implemented as an immediate local remove
  // => no big re-fetch needed
  const handleUnlikePublicChar = async (publicId: number) => {
    if (!clerkId) return;
    try {
      const res = await fetch(
        `${BASE_URL}/publicCharacters/${publicId}/toggle-like`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userClerkId: clerkId }),
        }
      );
      const data = await res.json();
      if (res.ok) {
        removeLikedCharacter(publicId);
        removeLocalPublicCharacter(publicId);
      } else {
        console.error('Error unliking:', data.error);
      }
    } catch (err) {
      console.error('handleUnlike error:', err);
    }
  };

  const handleChooseModel = (charId: string, newModelName: string) => {
    const isDownloaded = downloadedModels.includes(`${newModelName}.gguf`);
    if (!isDownloaded) {
      Alert.alert('Model Not Downloaded', 'Please download this model first.');
      return;
    }
    updateCharacter(charId, { modelName: newModelName });
    setShowDownloadModalForCharId(null);
  };

  // Edit Profile click (Pro gating)
  const handleEditProfileClick = () => {
    if (dbUser?.is_pro) {
      setShowProfileEditModal(true);
    } else {
      setShowBecomeProModal(true);
    }
  };

  const renderCharacterCard = (c: any) => {
    const id = c.id;
    const name = c.name;
    const modelName = c.modelName;
    const isReadOnly = !!c.isReadOnly;
    const likesCount = c.likes_count || 0;
    const downloadsCount = c.downloads_count || 0;

    const isModelDownloaded = downloadedModels.includes(`${modelName}.gguf`);
    const modelLabelPrefix = isModelDownloaded ? 'Model:' : 'Model missing:';

    return (
      <TouchableOpacity
        key={id}
        activeOpacity={0.8}
        onPress={() => handleSelectCharacter(id)}
        style={{
          flexDirection: 'column',
          backgroundColor: cardBgColor,
          borderRadius: 8,
          padding: 12,
          marginBottom: 8,
        }}
      >
        {/* Top row: Name + actions */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text
            style={{
              fontSize: 16,
              color: headingColor,
              marginRight: 8,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {name}
          </Text>

          <View style={{ flexDirection: 'row' }}>
            {!isReadOnly && (
              <>
                <TouchableOpacity onPress={() => openEditModal(id)}>
                  <Ionicons
                    name="create-outline"
                    size={20}
                    color={headingColor}
                    style={{ marginRight: 12 }}
                  />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleDelete(id)}>
                  <Ionicons name="trash-outline" size={20} color="#FF0000" />
                </TouchableOpacity>
              </>
            )}
            {isReadOnly && c.publicId && (
              <>
                <TouchableOpacity
                  onPress={() => handleUnlikePublicChar(c.publicId)}
                  style={{ marginLeft: 6 }}
                >
                  <Ionicons
                    name="heart-dislike-outline"
                    size={20}
                    color="#f44336"
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setShowDownloadModalForCharId(id)}
                  style={{ marginLeft: 6 }}
                >
                  <Ionicons name="caret-down" size={22} color={headingColor} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Model label */}
        <Text
          style={{
            marginTop: 4,
            color: '#666',
            fontSize: 14,
          }}
          numberOfLines={1}
        >
          {modelLabelPrefix} {modelName}
        </Text>

        {/* Likes & Downloads */}
        <View
          style={{ flexDirection: 'row', marginTop: 8, alignItems: 'center' }}
        >
          <Ionicons
            name="heart"
            size={16}
            color="#f44336"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 12 }}>
            {likesCount}
          </Text>

          <Ionicons
            name="download"
            size={16}
            color="#3f51b5"
            style={{ marginRight: 4 }}
          />
          <Text style={{ color: headingColor, marginRight: 12 }}>
            {downloadsCount}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loadingDbUser) {
    return (
      <SafeAreaView
        className="flex-1"
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#000' : '#fff',
        }}
      >
        <ActivityIndicator color="#888" size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-theme-light-background dark:bg-theme-dark-background">
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 8,
        }}
      >
        <Text
          style={{
            fontSize: 18,
            fontWeight: 'bold',
            color: headingColor,
          }}
        >
          Profile
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
      >
        {/* Avatar with Pro Badge */}
        <View
          style={{
            position: 'relative',
            alignSelf: 'center',
            marginTop: 24,
            marginBottom: 24,
          }}
        >
          <Image
            source={avatarUrl}
            style={{
              width: 120,
              height: 120,
              borderRadius: 60,
            }}
          />
          {dbUser?.is_pro && (
            <View
              style={{
                position: 'absolute',
                bottom: 5,
                left: 0,
                right: 0,
                alignItems: 'center',
              }}
            >
              <View
                style={{
                  backgroundColor: '#fff',
                  borderRadius: 10,
                  padding: 2,
                }}
              >
                <MaterialIcons name="verified" size={20} color="#1DA1F2" />
              </View>
            </View>
          )}
        </View>

        {/* User info from DB (if available) */}
        {dbUser ? (
          <View
            style={{
              position: 'relative',
              borderRadius: 8,
              paddingHorizontal: 16,
              paddingVertical: 12,
              marginBottom: 16,
              backgroundColor: cardBgColor,
            }}
          >
            {/* Edit Icon always visible */}
            <TouchableOpacity
              onPress={handleEditProfileClick}
              style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}
            >
              <Ionicons name="create-outline" size={20} color={headingColor} />
            </TouchableOpacity>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 4 }}>
              Username: @{dbUser.username}
            </Text>
            {dbUser.display_name ? (
              <Text style={{ fontSize: 14, color: '#666', marginBottom: 4 }}>
                Display Name: {dbUser.display_name}
              </Text>
            ) : null}
            {dbUser.bio ? (
              <Text style={{ fontSize: 14, color: '#666', marginBottom: 4 }}>
                Bio: {dbUser.bio}
              </Text>
            ) : null}
            <Text style={{ fontSize: 14, color: '#666' }}>
              Pro: {dbUser.is_pro ? 'Yes' : 'No'}
            </Text>
          </View>
        ) : (
          <View
            style={{
              borderRadius: 8,
              paddingHorizontal: 16,
              paddingVertical: 12,
              marginBottom: 16,
              backgroundColor: cardBgColor,
            }}
          >
            <Text style={{ color: headingColor }}>
              No user data found in DB yet.
            </Text>
          </View>
        )}

        {/* Logout Button */}
        <TouchableOpacity
          onPress={confirmSignOut}
          style={{
            alignSelf: 'center',
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: cardBgColor,
            borderRadius: 20,
            paddingHorizontal: 16,
            paddingVertical: 8,
          }}
        >
          <Ionicons name="log-out-outline" size={18} color="#666" />
          <Text style={{ marginLeft: 6, color: headingColor }}>Logout</Text>
        </TouchableOpacity>

        {/* My Characters */}
        <View style={{ marginTop: 24 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: 'bold',
                color: headingColor,
              }}
            >
              My Characters
            </Text>
            <TouchableOpacity onPress={openCreateModal}>
              <Ionicons
                name="add-circle-outline"
                size={24}
                color={headingColor}
              />
            </TouchableOpacity>
          </View>

          {/* If user has zero non-readOnly characters */}
          {characters.filter((ch) => !ch.isReadOnly).length === 0 && (
            <Text style={{ fontStyle: 'italic', color: '#666' }}>
              No characters created yet. Tap + to create one.
            </Text>
          )}

          {/* Show local non-readOnly characters */}
          {characters
            .filter((ch) => !ch.isReadOnly)
            .map((char) => renderCharacterCard(char))}
        </View>

        {/* Liked Public Characters */}
        {characters.filter((ch) => ch.isReadOnly).length > 0 && (
          <View style={{ marginTop: 24 }}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: 'bold',
                color: headingColor,
                marginBottom: 8,
              }}
            >
              Liked Public Characters
            </Text>
            {characters
              .filter((ch) => ch.isReadOnly)
              .map((char) => renderCharacterCard(char))}
          </View>
        )}
      </ScrollView>

      {/* Create/Edit Character Modal */}
      <CreateOrEditCharacterModal
        visible={isCharModalVisible}
        onClose={() => setIsCharModalVisible(false)}
        characterToEdit={editCharacter}
      />

      {/* Download model for read-only chars */}
      {showDownloadModalForCharId && (
        <DownloadModel
          visible={!!showDownloadModalForCharId}
          onClose={() => setShowDownloadModalForCharId(null)}
          onUseModel={(modelName) =>
            handleChooseModel(showDownloadModalForCharId!, modelName)
          }
        />
      )}

      {/* Profile Edit Modal (for Pro users) */}
      {dbUser && (
        <ProfileEditModal
          visible={showProfileEditModal}
          onClose={() => setShowProfileEditModal(false)}
          initialUserData={{
            clerk_id: dbUser.clerk_id,
            username: dbUser.username,
            display_name: dbUser.display_name,
            bio: dbUser.bio,
          }}
          onUpdated={(updated) => {
            setDbUser((prev: any) => ({
              ...prev,
              ...updated,
            }));
          }}
        />
      )}

      {/* Become Pro Modal (for non-Pro users) */}
      {showBecomeProModal && (
        <BecomeProModal
          visible={showBecomeProModal}
          onClose={() => setShowBecomeProModal(false)}
          onPurchaseSuccess={() => {
            // Mark user as pro after successful purchase.
            setDbUser((prev: any) => ({ ...prev, is_pro: true }));
          }}
        />
      )}
    </SafeAreaView>
  );
};

export default Profile;
