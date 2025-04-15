// components/CreateOrEditCharacterModal.tsx

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  useColorScheme,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useStore, Character } from '@/store';
import DownloadModel from './DownloadModel';
import { useUser } from '@clerk/clerk-expo';
import { BACKEND_URL } from '@/constants';

const BASE_URL = BACKEND_URL;

type Props = {
  visible: boolean;
  onClose: () => void;
  characterToEdit?: Character | null;
};

const CreateOrEditCharacterModal: React.FC<Props> = ({
  visible,
  onClose,
  characterToEdit,
}) => {
  const colorScheme = useColorScheme();
  const {
    downloadedModels,
    addCharacter,
    updateCharacter,
    setDidUserCloseDownloadModal,
  } = useStore();
  const { user } = useUser();

  // New subtitle state
  const [subtitle, setSubtitle] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [conversationStyle, setConversationStyle] = useState('');
  const [modelName, setModelName] = useState('');
  const [showDownloadModel, setShowDownloadModel] = useState(false);

  // Private/Public toggle
  const [isPublic, setIsPublic] = useState(true);
  const [publicCharacterId, setPublicCharacterId] = useState<number | null>(
    null
  );

  const isEditMode = !!characterToEdit;
  const isReadOnly = !!characterToEdit?.isReadOnly;

  useEffect(() => {
    if (visible) {
      setName(characterToEdit?.name ?? '');
      setSubtitle(characterToEdit?.subtitle ?? '');
      setDescription(characterToEdit?.description ?? '');
      setConversationStyle(characterToEdit?.conversationStyle ?? '');
      setModelName(characterToEdit?.modelName ?? '');
      setPublicCharacterId(characterToEdit?.publicId ?? null);
      setIsPublic(!!characterToEdit?.publicId);

      setShowDownloadModel(false);
      setDidUserCloseDownloadModal(false);
    }
  }, [visible, characterToEdit, setDidUserCloseDownloadModal]);

  const handleUseModel = (chosenModelName: string) => {
    setModelName(chosenModelName);
    setShowDownloadModel(false);
  };

  const handleClose = () => {
    setDidUserCloseDownloadModal(true);
    onClose();
  };

  const isModelDownloaded = downloadedModels.includes(`${modelName}.gguf`);

  // Ensure form is valid
  const isFormValid = () => {
    // Must have at least one downloaded model
    if (downloadedModels.length === 0) return false;
    // Model must be chosen and downloaded
    if (!modelName || !isModelDownloaded) return false;
    // Basic text checks
    if (name.trim().length < 3) return false;
    if (description.trim().length < 21) return false;
    // Must have at least 3 <User>: examples
    const userMatches = conversationStyle.match(/<User>:/g);
    if (!userMatches || userMatches.length < 3) return false;
    return true;
  };

  // Sync with server DB
  const syncWithBackend = async (localId?: string) => {
    try {
      if (!user?.id) return;
      if (isPublic) {
        // create or update
        const bodyData = {
          id: publicCharacterId,
          clerkId: user.id,
          name: name.trim(),
          subtitle: subtitle.trim(),
          description: description.trim(),
          conversationStyle: conversationStyle.trim(),
          modelName: modelName.trim(),
        };
        const res = await fetch(`${BASE_URL}/publicCharacters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyData),
        });
        const data = await res.json();
        if (res.ok && data.data?.length > 0) {
          const dbRec = data.data[0];
          setPublicCharacterId(dbRec.id);
          if (localId) {
            updateCharacter(localId, { publicId: dbRec.id });
          }
        }
      } else {
        // If switching from public => private, remove from DB
        if (publicCharacterId) {
          const res = await fetch(
            `${BASE_URL}/publicCharacters/${publicCharacterId}`,
            {
              method: 'DELETE',
            }
          );
          await res.json();
          if (localId) {
            updateCharacter(localId, { publicId: null });
          }
          setPublicCharacterId(null);
        }
      }
    } catch (err) {
      console.error('syncWithBackend error:', err);
    }
  };

  // Helper: add a sample conversation snippet
  const handleAddExample = () => {
    if (name.trim().length < 3) return;
    const template = `<User>: Hello, how are you?\n<${name.trim()}>: I am good, what about you?\n\n`;
    setConversationStyle((prev) => prev + template);
  };

  const handleCreateOrUpdate = async () => {
    if (!isFormValid()) return;
    if (!user?.id) {
      Alert.alert(
        'Not logged in',
        'You must be logged in to create a character.'
      );
      return;
    }

    if (!isEditMode) {
      // Create locally
      const newId = Date.now().toString();
      addCharacter({
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        conversationStyle: conversationStyle.trim(),
        modelName: modelName.trim(),
        publicId: null,
      });
      Alert.alert('Success', 'Character created!');
      // Sync with server
      await syncWithBackend(newId);
    } else {
      // Update local
      updateCharacter(characterToEdit!.id, {
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        conversationStyle: conversationStyle.trim(),
        modelName: modelName.trim(),
      });
      Alert.alert('Success', 'Character updated!');
      await syncWithBackend(characterToEdit!.id);
    }
    onClose();
  };

  // Tailwind classes for the new public/private toggle styles
  const publicButtonContainerClass = `flex-1 p-3 rounded mr-2 ${
    isPublic
      ? 'bg-[#0D0D0D] dark:bg-[#FCFCFC]'
      : 'bg-[#0D0D0D]/50 dark:bg-[#FCFCFC]/50'
  }`;
  const publicButtonTextClass = `text-center font-bold ${
    isPublic ? 'text-white dark:text-black' : 'text-white dark:text-black'
  }`;

  const privateButtonContainerClass = `flex-1 p-3 rounded ${
    !isPublic
      ? 'bg-[#0D0D0D] dark:bg-[#FCFCFC]'
      : 'bg-[#0D0D0D]/50 dark:bg-[#FCFCFC]/50'
  }`;
  const privateButtonTextClass = `text-center font-bold ${
    !isPublic ? 'text-white dark:text-black' : 'text-white dark:text-black'
  }`;

  // If readOnly => show fewer fields
  const showFullFields = !isReadOnly;

  // Display for model
  const noDownloadedModels = downloadedModels.length === 0;
  let modelDisplayText = 'Select a Model';
  if (noDownloadedModels) {
    modelDisplayText = 'No model available. Tap to download.';
  } else if (modelName && !isModelDownloaded) {
    modelDisplayText = `Model missing: ${modelName}`;
  } else if (modelName && isModelDownloaded) {
    modelDisplayText = `Selected: ${modelName}`;
  }

  // For controlling max 200 words in subtitle
  const handleSubtitleChange = (text: string) => {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount <= 200) {
      setSubtitle(text);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
        {/* Increased modal width to w-[95%] */}
        <View className="w-[100%] max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
          {/* Title */}
          <Text
            className="text-lg font-bold"
            style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}
          >
            {isReadOnly
              ? 'View Character'
              : isEditMode
                ? 'Edit Character'
                : 'Create Character'}
          </Text>

          {/* Removed the progress bar block here */}

          <ScrollView className="mt-3">
            {/* Model selection */}
            <Text
              className="mb-1"
              style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}
            >
              Model{isReadOnly ? '' : ' (must be downloaded)'}
            </Text>
            <TouchableOpacity
              onPress={() => setShowDownloadModel(true)}
              className="border border-gray-600 rounded p-3 mb-3"
            >
              <Text
                style={{
                  color: colorScheme === 'dark' ? '#999999' : '#666666',
                }}
              >
                {modelDisplayText}
              </Text>
            </TouchableOpacity>

            {/* Name */}
            <Text
              className="mb-1"
              style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000' }}
            >
              Name (max 100)
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={100}
              className="border border-gray-600 rounded p-3 mb-3"
              style={{
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
              }}
              placeholder="Character name"
              placeholderTextColor="#888"
              editable={!isReadOnly}
            />

            {showFullFields && (
              <>
                {/* Subtitle */}
                <Text
                  className="mb-1"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                  }}
                >
                  Subtitle (up to 200 words)
                </Text>
                <TextInput
                  value={subtitle}
                  onChangeText={handleSubtitleChange}
                  className="border border-gray-600 rounded p-3 mb-3"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    minHeight: 40,
                    textAlignVertical: 'top',
                  }}
                  multiline
                  placeholder="Short catchphrase or additional info"
                  placeholderTextColor="#888"
                />

                {/* Description */}
                <Text
                  className="mb-1"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                  }}
                >
                  Description (max 500, min 21 chars)
                </Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  maxLength={500}
                  className="border border-gray-600 rounded p-3 mb-3"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    minHeight: 60,
                    textAlignVertical: 'top',
                  }}
                  multiline
                  placeholder="Describe your character here"
                  placeholderTextColor="#888"
                />

                {/* Conversation Style */}
                <Text
                  className="mb-1"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                  }}
                >
                  Conversation Style (max 1000, ≥3 User examples)
                </Text>
                <TextInput
                  value={conversationStyle}
                  onChangeText={setConversationStyle}
                  maxLength={1000}
                  className="border border-gray-600 rounded p-3 mb-3"
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    minHeight: 100,
                    textAlignVertical: 'top',
                  }}
                  multiline
                  placeholder={`<User>: ...\n<${name || 'Character'}>: ...`}
                  placeholderTextColor="#888"
                />

                <TouchableOpacity
                  onPress={handleAddExample}
                  disabled={name.trim().length < 3}
                  className="mb-3"
                  style={{ opacity: name.trim().length < 3 ? 0.5 : 1 }}
                >
                  <Text className="text-blue-500 font-bold">+ Add Example</Text>
                </TouchableOpacity>

                {/* Private / Public Toggler */}
                <View className="flex-row mb-3">
                  {/* Public Button */}
                  <TouchableOpacity
                    className={publicButtonContainerClass}
                    onPress={() => setIsPublic(true)}
                  >
                    <Text className={publicButtonTextClass}>Public</Text>
                  </TouchableOpacity>

                  {/* Private Button */}
                  <TouchableOpacity
                    className={privateButtonContainerClass}
                    onPress={() => setIsPublic(false)}
                  >
                    <Text className={privateButtonTextClass}>Private</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {/* If readOnly => no create/update button */}
            {!isReadOnly && (
              <TouchableOpacity
                onPress={handleCreateOrUpdate}
                disabled={!isFormValid()}
                className={`rounded p-3 ${
                  isFormValid()
                    ? colorScheme === 'dark'
                      ? 'bg-white'
                      : 'bg-black'
                    : 'bg-gray-400'
                }`}
              >
                <Text
                  className="text-center font-bold"
                  style={{
                    color: isFormValid()
                      ? colorScheme === 'dark'
                        ? '#000000'
                        : '#FFFFFF'
                      : '#666666',
                  }}
                >
                  {isEditMode ? 'Update' : 'Create'}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>

          {/* Close Icon */}
          <TouchableOpacity
            onPress={handleClose}
            className="absolute top-3 right-3"
          >
            <Ionicons
              name="close"
              size={26}
              color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
            />
          </TouchableOpacity>
        </View>

        {showDownloadModel && (
          <DownloadModel
            visible={showDownloadModel}
            onClose={() => setShowDownloadModel(false)}
            onUseModel={handleUseModel}
          />
        )}
      </View>
    </Modal>
  );
};

export default CreateOrEditCharacterModal;
