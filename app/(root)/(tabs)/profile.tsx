// app/(root)/(tabs)/profile.tsx

import React, { useState, useEffect, useMemo } from 'react';
import { useAuth, signOut } from '@/lib/supabase';
import {
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { themedAlert } from '@/components/ThemedAlert';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useStore, formatBytes, isImageGenModel, getModelFileName } from '@/store';
import CreateOrEditCharacterModal from '@/components/CreateOrEditCharacterModal';
import DownloadModel from '@/components/DownloadModel';
import {
  getProfileBundle,
  deletePublicCharacter,
  toggleCharacterLike,
  deleteOwnAccount,
} from '@/lib/supabase-api';

// NEW imports
import ProfileEditModal from '@/components/ProfileEditModal';

const Profile = () => {
  const { user } = useAuth();
  const router = useRouter();
  const colorScheme = useColorScheme();

  const headingColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const cardBgColor = colorScheme === 'dark' ? '#242424' : '#f5f5f5';

  // Per-field selectors so Profile doesn't re-render on every
  // chatHistory update while the user is streaming on Home.
  const characters = useStore((s) => s.characters);
  const deleteCharacter = useStore((s) => s.deleteCharacter);
  const downloadedModels = useStore((s) => s.downloadedModels);
  const setActiveCharacter = useStore((s) => s.setActiveCharacter);
  const setLikedCharacters = useStore((s) => s.setLikedCharacters);
  const removeLikedCharacter = useStore((s) => s.removeLikedCharacter);
  const updateCharacter = useStore((s) => s.updateCharacter);
  const removeLocalPublicCharacter = useStore((s) => s.removeLocalPublicCharacter);
  const resetAllUserData = useStore((s) => s.resetAllUserData);
  const models = useStore((s) => s.models);
  const activeDownloads = useStore((s) => s.activeDownloads);
  const downloadProgress = useStore((s) => s.downloadProgress);
  const downloadStats = useStore((s) => s.downloadStats);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const deleteModel = useStore((s) => s.deleteModel);
  const downloadModel = useStore((s) => s.downloadModel);
  const selectedModel = useStore((s) => s.selectedModel);
  const selectModel = useStore((s) => s.selectModel);

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

  const userId = user?.id;

  // Single "fetchProfileBundle" call
  const fetchProfileBundleData = async () => {
    setLoadingDbUser(true);
    try {
      const data = await getProfileBundle();
      // data => { dbUser, published, liked }
      setDbUser(data.dbUser);

      // 1) Merge "published" into local store
      const publishedChars = data.published || [];
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
    } catch (error) {
      if (__DEV__) console.error('fetchProfileBundle error:', error);
    } finally {
      setLoadingDbUser(false);
    }
  };

  // On sign in, do a single "profileBundle" call
  useEffect(() => {
    if (!userId) return;
    fetchProfileBundleData();
  }, [userId]);

  const handleSignOut = async () => {
    try {
      await signOut();
      resetAllUserData();
      router.replace('/(root)/(tabs)/home');
    } catch (error: any) {
      if (__DEV__) console.error('Sign out error:', error);
    }
  };

  const confirmSignOut = () => {
    themedAlert(
      'Confirm Logout',
      'All unsaved data will be lost once logged out. Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Logout', style: 'destructive', onPress: handleSignOut },
      ]
    );
  };

  const handleDeleteAccount = async () => {
    try {
      await deleteOwnAccount();
      resetAllUserData();
      await signOut();
      router.replace('/(root)/(tabs)/home');
    } catch (error: any) {
      if (__DEV__) console.error('Delete account error:', error);
      themedAlert('Error', 'Failed to delete account. Please try again.');
    }
  };

  const confirmDeleteAccount = () => {
    themedAlert(
      'Delete Account',
      'This will permanently delete your account, all your characters, and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: () => {
            themedAlert(
              'Are you sure?',
              'This is your last chance. All your data will be permanently deleted.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Yes, Delete', style: 'destructive', onPress: handleDeleteAccount },
              ]
            );
          },
        },
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
    themedAlert(
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
                await deletePublicCharacter(found.publicId);
              } catch (err) {
                if (__DEV__) console.error('Failed to delete from server', err);
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
    // setActiveCharacter is synchronous — check if it succeeded
    // (it bails with an alert if no model is loaded)
    if (useStore.getState().activeCharacter?.id) {
      router.push('/(root)/(tabs)/home');
    }
  };

  const handleUnlikePublicChar = async (publicId: number) => {
    if (!userId) return;
    try {
      await toggleCharacterLike(publicId);
      removeLikedCharacter(publicId);
      removeLocalPublicCharacter(publicId);
    } catch (err) {
      if (__DEV__) console.error('handleUnlike error:', err);
    }
  };

  const handleChooseModel = (charId: string, newModelName: string) => {
    const isDownloaded = downloadedModels.includes(`${newModelName}.gguf`);
    if (!isDownloaded) {
      themedAlert('Model Not Downloaded', 'Please download this model first.');
      return;
    }
    updateCharacter(charId, { modelName: newModelName });
    setShowDownloadModalForCharId(null);
  };

  const handleEditProfileClick = () => {
    setShowProfileEditModal(true);
  };

  // Split once per characters-array change, not on every render. The
  // previous inline .filter() ran three times per render (own-count,
  // liked-count, own-list) — on long lists it added up, and every
  // unrelated store update re-ran them all.
  const ownCharacters = useMemo(
    () => characters.filter((ch: any) => !ch.isReadOnly),
    [characters],
  );
  const likedCharacters = useMemo(
    () => characters.filter((ch: any) => ch.isReadOnly),
    [characters],
  );

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
        {/* Avatar — default silhouette until the user uploads one */}
        <View
          style={{
            alignSelf: 'center',
            marginTop: 24,
            marginBottom: 24,
          }}
        >
          <Ionicons
            name="person-circle-outline"
            size={120}
            color={headingColor}
          />
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

        {/* Logout & Delete Account */}
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12 }}>
          <TouchableOpacity
            onPress={confirmSignOut}
            style={{
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

          <TouchableOpacity
            onPress={confirmDeleteAccount}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colorScheme === 'dark' ? '#3A1515' : '#FEE2E2',
              borderRadius: 20,
              paddingHorizontal: 16,
              paddingVertical: 8,
            }}
          >
            <Ionicons name="trash-outline" size={18} color="#EF4444" />
            <Text style={{ marginLeft: 6, color: '#EF4444' }}>Delete Account</Text>
          </TouchableOpacity>
        </View>

        {/* Downloads button */}
        <TouchableOpacity
          onPress={() => router.push('/(root)/DownloadsPage')}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: cardBgColor,
            borderRadius: 10,
            padding: 14,
            marginTop: 24,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="download-outline" size={22} color={headingColor} />
            <Text style={{ color: headingColor, fontSize: 16, fontWeight: '600', marginLeft: 10 }}>
              Downloads
            </Text>
            {activeDownloads instanceof Set && activeDownloads.size > 0 && (
              <View style={{
                backgroundColor: '#3B82F6',
                borderRadius: 10,
                minWidth: 20,
                height: 20,
                alignItems: 'center',
                justifyContent: 'center',
                marginLeft: 8,
                paddingHorizontal: 6,
              }}>
                <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>
                  {activeDownloads.size}
                </Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ color: colorScheme === 'dark' ? '#6B7280' : '#9CA3AF', fontSize: 13, marginRight: 4 }}>
              {downloadedModels.length} model{downloadedModels.length !== 1 ? 's' : ''}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colorScheme === 'dark' ? '#6B7280' : '#9CA3AF'} />
          </View>
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
          {ownCharacters.length === 0 && (
            <Text style={{ fontStyle: 'italic', color: '#666' }}>
              No characters created yet. Tap + to create one.
            </Text>
          )}

          {/* Show local non-readOnly characters */}
          {ownCharacters.map((char: any) => renderCharacterCard(char))}
        </View>

        {/* Liked Public Characters */}
        {likedCharacters.length > 0 && (
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
            {likedCharacters.map((char: any) => renderCharacterCard(char))}
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

      {/* Profile Edit Modal */}
      {dbUser && (
        <ProfileEditModal
          visible={showProfileEditModal}
          onClose={() => setShowProfileEditModal(false)}
          initialUserData={{
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

    </SafeAreaView>
  );
};

export default Profile;
