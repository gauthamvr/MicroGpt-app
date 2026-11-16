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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons } from '@expo/vector-icons';

import { useStore, Character } from '@/store';
import { useAuth } from '@/lib/supabase';
import {
  createPublicCharacter,
  updatePublicCharacter,
  deletePublicCharacter,
} from '@/lib/supabase-api';
import { checkCharacterText } from '@/lib/content-safety';

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
  const isDark = colorScheme === 'dark';
  const downloadedModels = useStore((s) => s.downloadedModels);
  const addCharacter = useStore((s) => s.addCharacter);
  const updateCharacter = useStore((s) => s.updateCharacter);
  const { user } = useAuth();

  const [subtitle, setSubtitle] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [conversationStyle, setConversationStyle] = useState('');

  // Private/Public toggle
  const [isPublic, setIsPublic] = useState(true);
  const [publicCharacterId, setPublicCharacterId] = useState<number | null>(
    null
  );

  const isEditMode = !!characterToEdit;
  const isReadOnly = !!characterToEdit?.isReadOnly;

  // Theme colors
  const bgColor = isDark ? '#1C1C1E' : '#FFFFFF';
  const cardBg = isDark ? '#2C2C2E' : '#F5F5F5';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = isDark ? '#9BA1A6' : '#6B7280';
  const inputBg = isDark ? '#2C2C2E' : '#F7F7F8';
  const inputBorder = isDark ? '#3A3A3C' : '#E5E5EA';
  const accentColor = isDark ? '#FFFFFF' : '#000000';
  const accentTextColor = isDark ? '#000000' : '#FFFFFF';
  const disabledBg = isDark ? '#3A3A3C' : '#D1D1D6';
  const disabledText = isDark ? '#636366' : '#AEAEB2';

  useEffect(() => {
    if (visible) {
      setName(characterToEdit?.name ?? '');
      setSubtitle(characterToEdit?.subtitle ?? '');
      setDescription(characterToEdit?.description ?? '');
      setConversationStyle(characterToEdit?.conversationStyle ?? '');
      setPublicCharacterId(characterToEdit?.publicId ?? null);
      setIsPublic(!!characterToEdit?.publicId);
    }
  }, [visible, characterToEdit]);

  const handleClose = () => {
    onClose();
  };

  // Validation: name required (3+ chars), at least one of description or conversationStyle
  const isFormValid = () => {
    if (name.trim().length < 3) return false;
    if (description.trim().length === 0 && conversationStyle.trim().length === 0)
      return false;
    return true;
  };

  // Resolve the model name: keep existing, or fall back to first downloaded
  const resolveModelName = (): string => {
    if (characterToEdit?.modelName) return characterToEdit.modelName;
    if (downloadedModels.length > 0) return downloadedModels[0].replace('.gguf', '');
    return '';
  };

  // Sync with server DB
  const syncWithBackend = async (localId?: string) => {
    try {
      if (!user?.id) return;
      if (isPublic) {
        const charData = {
          name: name.trim(),
          subtitle: subtitle.trim(),
          description: description.trim(),
          conversationStyle: conversationStyle.trim(),
          modelName: resolveModelName(),
        };

        const publicText = [charData.name, charData.subtitle, charData.description, charData.conversationStyle].join('\n');
        if (!checkCharacterText(publicText).allowed) {
          themedAlert(
            'Not shared publicly',
            "This character contains sexual content, so it can't be shared with the community. It's still saved on your device.",
          );
          return;
        }

        if (publicCharacterId) {
          const dbRec = await updatePublicCharacter(publicCharacterId, charData);
          if (localId) {
            updateCharacter(localId, { publicId: dbRec.id });
          }
        } else {
          const dbRec = await createPublicCharacter(charData);
          setPublicCharacterId(dbRec.id);
          if (localId) {
            updateCharacter(localId, { publicId: dbRec.id });
          }
        }
      } else {
        if (publicCharacterId) {
          await deletePublicCharacter(publicCharacterId);
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

  const handleAddExample = () => {
    if (name.trim().length < 3) return;
    const template = `<User>: Hello, how are you?\n<${name.trim()}>: I am good, what about you?\n\n`;
    setConversationStyle((prev) => prev + template);
  };

  const handleCreateOrUpdate = async () => {
    if (!isFormValid()) return;
    if (!user?.id) {
      themedAlert(
        'Not logged in',
        'You must be logged in to create a character.'
      );
      return;
    }

    const modelName = resolveModelName();

    if (!isEditMode) {
      const newId = Date.now().toString();
      addCharacter({
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        conversationStyle: conversationStyle.trim(),
        modelName,
        publicId: null,
      });
      themedAlert('Success', 'Character created!');
      await syncWithBackend(newId);
    } else {
      updateCharacter(characterToEdit!.id, {
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        conversationStyle: conversationStyle.trim(),
        modelName,
      });
      themedAlert('Success', 'Character updated!');
      await syncWithBackend(characterToEdit!.id);
    }
    onClose();
  };

  const handleSubtitleChange = (text: string) => {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount <= 200) {
      setSubtitle(text);
    }
  };

  const showFullFields = !isReadOnly;

  const renderInput = (
    value: string,
    onChangeText: (t: string) => void,
    placeholder: string,
    options?: {
      multiline?: boolean;
      minHeight?: number;
      maxLength?: number;
      editable?: boolean;
      mono?: boolean;
    }
  ) => (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={isDark ? '#636366' : '#AEAEB2'}
      maxLength={options?.maxLength}
      multiline={options?.multiline}
      editable={options?.editable !== false}
      style={{
        backgroundColor: inputBg,
        borderWidth: 1,
        borderColor: inputBorder,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: textColor,
        fontSize: 15,
        lineHeight: 20,
        marginBottom: 16,
        ...(options?.minHeight ? { minHeight: options.minHeight, textAlignVertical: 'top' as const } : {}),
        ...(options?.mono ? { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 } : {}),
      }}
    />
  );

  const renderLabel = (label: string, hint?: string) => (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 6 }}>
      <Text style={{ color: textColor, fontSize: 14, fontWeight: '600' }}>
        {label}
      </Text>
      {hint ? (
        <Text style={{ color: subTextColor, fontSize: 12, marginLeft: 6 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
          }}
        >
          <View
            style={{
              backgroundColor: bgColor,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: '92%',
              paddingTop: 12,
            }}
          >
            {/* Drag handle */}
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: isDark ? '#636366' : '#D1D1D6',
                alignSelf: 'center',
                marginBottom: 12,
              }}
            />

            {/* Header */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingHorizontal: 20,
                marginBottom: 16,
              }}
            >
              <Text
                style={{
                  fontSize: 20,
                  fontWeight: 'bold',
                  color: textColor,
                }}
              >
                {isReadOnly
                  ? 'View Character'
                  : isEditMode
                    ? 'Edit Character'
                    : 'Create Character'}
              </Text>
              <TouchableOpacity
                onPress={handleClose}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: cardBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="close" size={18} color={subTextColor} />
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              removeClippedSubviews
            >
              {/* Name */}
              {renderLabel('Name', 'required')}
              {renderInput(name, setName, 'Character name', {
                maxLength: 100,
                editable: !isReadOnly,
              })}

              {showFullFields && (
                <>
                  {/* Subtitle */}
                  {renderLabel('Subtitle', 'optional, up to 200 words')}
                  {renderInput(subtitle, handleSubtitleChange, 'Short tagline or catchphrase', {
                    multiline: true,
                    minHeight: 44,
                  })}

                  {/* Description */}
                  {renderLabel('Description', 'fill this or conversation style')}
                  {renderInput(description, setDescription, 'Describe your character — personality, background, traits...', {
                    multiline: true,
                    minHeight: 80,
                    maxLength: 500,
                  })}

                  {/* Conversation Style */}
                  {renderLabel('Conversation Style', 'fill this or description')}
                  {renderInput(
                    conversationStyle,
                    setConversationStyle,
                    `<User>: ...\n<${name || 'Character'}>: ...`,
                    {
                      multiline: true,
                      minHeight: 100,
                      maxLength: 1000,
                      mono: true,
                    }
                  )}

                  {/* Add Example button */}
                  <TouchableOpacity
                    onPress={handleAddExample}
                    disabled={name.trim().length < 3}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      alignSelf: 'flex-start',
                      marginTop: -8,
                      marginBottom: 20,
                      opacity: name.trim().length < 3 ? 0.4 : 1,
                    }}
                  >
                    <Ionicons name="add-circle-outline" size={16} color="#3B82F6" />
                    <Text
                      style={{
                        color: '#3B82F6',
                        fontSize: 13,
                        fontWeight: '600',
                        marginLeft: 4,
                      }}
                    >
                      Add Example
                    </Text>
                  </TouchableOpacity>

                  {/* Public / Private Toggle */}
                  {renderLabel('Visibility')}
                  <View
                    style={{
                      flexDirection: 'row',
                      backgroundColor: cardBg,
                      borderRadius: 10,
                      padding: 3,
                      marginBottom: 24,
                    }}
                  >
                    <TouchableOpacity
                      onPress={() => setIsPublic(true)}
                      style={{
                        flex: 1,
                        paddingVertical: 10,
                        borderRadius: 8,
                        alignItems: 'center',
                        backgroundColor: isPublic ? accentColor : 'transparent',
                      }}
                    >
                      <Text
                        style={{
                          fontWeight: '600',
                          fontSize: 14,
                          color: isPublic ? accentTextColor : subTextColor,
                        }}
                      >
                        Public
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => setIsPublic(false)}
                      style={{
                        flex: 1,
                        paddingVertical: 10,
                        borderRadius: 8,
                        alignItems: 'center',
                        backgroundColor: !isPublic ? accentColor : 'transparent',
                      }}
                    >
                      <Text
                        style={{
                          fontWeight: '600',
                          fontSize: 14,
                          color: !isPublic ? accentTextColor : subTextColor,
                        }}
                      >
                        Private
                      </Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              {/* Create / Update Button */}
              {!isReadOnly && (
                <TouchableOpacity
                  onPress={handleCreateOrUpdate}
                  disabled={!isFormValid()}
                  style={{
                    backgroundColor: isFormValid() ? accentColor : disabledBg,
                    borderRadius: 12,
                    paddingVertical: 14,
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <Text
                    style={{
                      color: isFormValid() ? accentTextColor : disabledText,
                      fontWeight: 'bold',
                      fontSize: 16,
                    }}
                  >
                    {isEditMode ? 'Update Character' : 'Create Character'}
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

export default CreateOrEditCharacterModal;
