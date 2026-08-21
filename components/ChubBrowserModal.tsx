// components/ChubBrowserModal.tsx

import React, { useState, useCallback, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  useColorScheme,
  Image,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { themedAlert } from '@/components/ThemedAlert';
import { useStore } from '@/store';
import {
  searchChubCharacters,
  getPopularChubCharacters,
  fetchChubCharacter,
  convertChubToMicroGPT,
  ChubSearchResult,
  ChubCharacterDefinition,
} from '@/lib/chub-api';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export default function ChubBrowserModal({ visible, onClose }: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const bgColor = isDark ? '#1C1C1E' : '#FFFFFF';
  const cardBg = isDark ? '#2C2C2E' : '#F5F5F5';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = isDark ? '#9BA1A6' : '#666666';
  const inputBg = isDark ? '#2C2C2E' : '#F5F5F5';
  const borderColor = isDark ? '#444444' : '#CCCCCC';

  const router = useRouter();
  const downloadedModels = useStore((s) => s.downloadedModels);
  const addCharacter = useStore((s) => s.addCharacter);
  const setActiveCharacter = useStore((s) => s.setActiveCharacter);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChubSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Detail view state
  const [selectedItem, setSelectedItem] = useState<ChubSearchResult | null>(null);
  const [detailDef, setDetailDef] = useState<ChubCharacterDefinition | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Editable fields in detail view
  const [editName, setEditName] = useState('');
  const [editPersonality, setEditPersonality] = useState('');
  const [editScenario, setEditScenario] = useState('');
  const [editFirstMessage, setEditFirstMessage] = useState('');
  const [editExamples, setEditExamples] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const loadPopular = useCallback(async () => {
    setLoading(true);
    try {
      const popular = await getPopularChubCharacters(20);
      setResults(popular);
    } catch (err) {
      if (__DEV__) console.error('Chub popular fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load popular characters when modal opens
  useEffect(() => {
    if (visible && results.length === 0 && !hasSearched) {
      loadPopular();
    }
  }, [visible, results.length, hasSearched, loadPopular]);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      // Empty search → reload popular
      setHasSearched(false);
      await loadPopular();
      return;
    }
    setLoading(true);
    setHasSearched(true);
    try {
      const data = await searchChubCharacters(query.trim());
      setResults(data.nodes);
    } catch (err) {
      if (__DEV__) console.error('Chub search error:', err);
      themedAlert('Error', 'Failed to search characters. Try again.');
    } finally {
      setLoading(false);
    }
  }, [query, loadPopular]);

  const handleOpenDetail = async (item: ChubSearchResult) => {
    setSelectedItem(item);
    setDetailDef(null);
    setIsEditing(false);
    setLoadingDetail(true);
    try {
      const def = await fetchChubCharacter(item.fullPath);
      setDetailDef(def);
      // Populate editable fields with the converted (mobile-optimized) version
      const converted = convertChubToMicroGPT(def, '');
      setEditName(converted.name);
      setEditPersonality(converted.description);
      setEditScenario(converted.subtitle);
      setEditFirstMessage(converted.firstMessage);
      setEditExamples(converted.conversationStyle);
    } catch (err) {
      if (__DEV__) console.error('Chub detail fetch error:', err);
      themedAlert('Error', 'Failed to load character details.');
      setSelectedItem(null);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleCloseDetail = () => {
    setSelectedItem(null);
    setDetailDef(null);
    setIsEditing(false);
  };

  // Add the character to the store and prompt to load it now or later
  const finalizeImport = (charData: {
    name: string;
    subtitle: string;
    description: string;
    conversationStyle: string;
    modelName: string;
    scenario?: string;
    firstMessage?: string;
    systemPrompt?: string;
    postHistoryInstructions?: string;
  }) => {
    addCharacter({
      ...charData,
      publicId: null,
    });

    // Find the just-added character (it's the last one with this name)
    const allChars = useStore.getState().characters;
    const newChar = [...allChars].reverse().find((c) => c.name === charData.name);

    themedAlert(
      'Imported',
      `"${charData.name}" added. Load it now? You can also find it under Profile > My Characters.`,
      [
        { text: 'Later', style: 'cancel', onPress: () => onClose() },
        {
          text: 'Load Now',
          onPress: () => {
            if (newChar) {
              setActiveCharacter(newChar.id);
              const st = useStore.getState();
              if (st.activeCharacter) {
                onClose();
                router.push('/(root)/(tabs)/home');
              }
            }
          },
        },
      ]
    );
  };

  const handleImportEdited = () => {
    if (downloadedModels.length === 0) {
      themedAlert(
        'No Model Available',
        'Please download a model first before importing a character.'
      );
      return;
    }

    if (editName.trim().length < 3) {
      themedAlert('Invalid', 'Name must be at least 3 characters.');
      return;
    }

    const defaultModel = downloadedModels[0].replace('.gguf', '');

    finalizeImport({
      name: editName.trim(),
      subtitle: editScenario.trim(),
      description: editPersonality.trim(),
      conversationStyle: editExamples.trim(),
      modelName: defaultModel,
      firstMessage: editFirstMessage.trim() || undefined,
    });
    handleCloseDetail();
  };

  const handleImportFromList = async (item: ChubSearchResult) => {
    if (downloadedModels.length === 0) {
      themedAlert(
        'No Model Available',
        'Please download a model first before importing a character.'
      );
      return;
    }

    const defaultModel = downloadedModels[0].replace('.gguf', '');
    setImporting(item.id);
    try {
      const def = await fetchChubCharacter(item.fullPath);
      const converted = convertChubToMicroGPT(def, defaultModel);
      finalizeImport({
        name: converted.name,
        subtitle: converted.subtitle,
        description: converted.description,
        conversationStyle: converted.conversationStyle,
        modelName: converted.modelName,
        scenario: converted.scenario || undefined,
        firstMessage: converted.firstMessage || undefined,
        systemPrompt: converted.systemPrompt || undefined,
        postHistoryInstructions: converted.postHistoryInstructions || undefined,
      });
    } catch (err) {
      if (__DEV__) console.error('Chub import error:', err);
      themedAlert('Error', 'Failed to import character. Try again.');
    } finally {
      setImporting(null);
    }
  };

  const renderItem = ({ item }: { item: ChubSearchResult }) => {
    const isImporting = importing === item.id;
    const tokenLabel = item.nTokens
      ? `${item.nTokens} tokens`
      : '';

    return (
      <TouchableOpacity
        onPress={() => handleOpenDetail(item)}
        activeOpacity={0.7}
        style={{
          backgroundColor: cardBg,
          borderRadius: 10,
          padding: 12,
          marginBottom: 8,
          flexDirection: 'row',
        }}
      >
        {/* Avatar */}
        {item.avatar_url ? (
          <Image
            source={{ uri: item.avatar_url }}
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              marginRight: 10,
              backgroundColor: borderColor,
            }}
          />
        ) : (
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              marginRight: 10,
              backgroundColor: borderColor,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="person" size={24} color={subTextColor} />
          </View>
        )}

        {/* Info */}
        <View style={{ flex: 1 }}>
          <Text
            style={{ color: textColor, fontWeight: 'bold', fontSize: 15 }}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          <Text
            style={{ color: subTextColor, fontSize: 12, marginTop: 2 }}
            numberOfLines={2}
          >
            {item.tagline || item.description || 'No description'}
          </Text>

          {/* Stats row */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginTop: 6,
            }}
          >
            <Ionicons
              name="star"
              size={13}
              color="#FFD700"
              style={{ marginRight: 3 }}
            />
            <Text style={{ color: subTextColor, fontSize: 11, marginRight: 12 }}>
              {item.starCount?.toLocaleString() || 0}
            </Text>

            <Ionicons
              name="chatbubble"
              size={13}
              color={subTextColor}
              style={{ marginRight: 3 }}
            />
            <Text style={{ color: subTextColor, fontSize: 11, marginRight: 12 }}>
              {item.nChats?.toLocaleString() || 0}
            </Text>

            {tokenLabel ? (
              <Text style={{ color: subTextColor, fontSize: 11 }}>
                {tokenLabel}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Import button */}
        <TouchableOpacity
          onPress={() => handleImportFromList(item)}
          disabled={isImporting}
          style={{
            alignSelf: 'center',
            backgroundColor: isDark ? '#FFFFFF' : '#000000',
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            marginLeft: 8,
          }}
        >
          {isImporting ? (
            <ActivityIndicator
              size="small"
              color={isDark ? '#000000' : '#FFFFFF'}
            />
          ) : (
            <Ionicons
              name="add"
              size={18}
              color={isDark ? '#000000' : '#FFFFFF'}
            />
          )}
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  // Reusable input style for edit fields
  const inputStyle = {
    backgroundColor: inputBg,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: textColor,
    borderWidth: 1,
    borderColor,
    fontSize: 14,
    marginBottom: 12,
  };

  const labelStyle = {
    color: subTextColor,
    fontSize: 12,
    marginBottom: 4,
    fontWeight: '600' as const,
  };

  // ─── Detail/Edit View ───
  const renderDetailView = () => {
    if (!selectedItem) return null;

    if (loadingDetail || !detailDef) {
      return (
        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <TouchableOpacity onPress={handleCloseDetail} style={{ marginRight: 8 }}>
              <Ionicons name="arrow-back" size={24} color={textColor} />
            </TouchableOpacity>
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: textColor }}>
              Loading...
            </Text>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={textColor} />
            <Text style={{ color: subTextColor, marginTop: 12, fontSize: 13 }}>
              Loading character details...
            </Text>
          </View>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        {/* Header with back button + edit toggle */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <TouchableOpacity
            onPress={handleCloseDetail}
            style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
          >
            <Ionicons name="arrow-back" size={24} color={textColor} />
            <Text
              style={{
                fontSize: 16,
                fontWeight: 'bold',
                color: textColor,
                marginLeft: 8,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {editName || selectedItem.name}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setIsEditing(!isEditing)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: isEditing ? (isDark ? '#FFFFFF' : '#000000') : cardBg,
            }}
          >
            <Ionicons
              name={isEditing ? 'checkmark' : 'create-outline'}
              size={16}
              color={isEditing ? (isDark ? '#000000' : '#FFFFFF') : textColor}
            />
            <Text
              style={{
                marginLeft: 4,
                fontSize: 12,
                fontWeight: '600',
                color: isEditing ? (isDark ? '#000000' : '#FFFFFF') : textColor,
              }}
            >
              {isEditing ? 'Done' : 'Edit'}
            </Text>
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" removeClippedSubviews>
          {/* Avatar + meta */}
          <View
            style={{
              flexDirection: 'row',
              marginBottom: 16,
              alignItems: 'center',
            }}
          >
            {selectedItem.avatar_url ? (
              <Image
                source={{ uri: selectedItem.avatar_url }}
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 12,
                  backgroundColor: borderColor,
                }}
              />
            ) : (
              <View
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 12,
                  backgroundColor: borderColor,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name="person" size={40} color={subTextColor} />
              </View>
            )}
            <View style={{ flex: 1, marginLeft: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <Ionicons name="star" size={14} color="#FFD700" style={{ marginRight: 4 }} />
                <Text style={{ color: subTextColor, fontSize: 12, marginRight: 12 }}>
                  {selectedItem.starCount?.toLocaleString() || 0}
                </Text>
                <Ionicons name="chatbubble" size={13} color={subTextColor} style={{ marginRight: 4 }} />
                <Text style={{ color: subTextColor, fontSize: 12 }}>
                  {selectedItem.nChats?.toLocaleString() || 0}
                </Text>
              </View>
              {selectedItem.nTokens ? (
                <Text style={{ color: subTextColor, fontSize: 11 }}>
                  Original: {selectedItem.nTokens} tokens
                </Text>
              ) : null}
              {selectedItem.tagline ? (
                <Text
                  style={{ color: subTextColor, fontSize: 12, marginTop: 4 }}
                  numberOfLines={2}
                >
                  {selectedItem.tagline}
                </Text>
              ) : null}
            </View>
          </View>

          {/* Mobile-optimization notice */}
          <View
            style={{
              backgroundColor: cardBg,
              borderRadius: 8,
              padding: 10,
              marginBottom: 16,
              flexDirection: 'row',
              alignItems: 'flex-start',
            }}
          >
            <Ionicons
              name="information-circle"
              size={16}
              color={subTextColor}
              style={{ marginRight: 6, marginTop: 1 }}
            />
            <Text style={{ color: subTextColor, fontSize: 11, flex: 1, lineHeight: 16 }}>
              Compacted for mobile LLMs (2K context). Edit any field below before importing.
            </Text>
          </View>

          {/* Name */}
          <Text style={labelStyle}>NAME</Text>
          <TextInput
            value={editName}
            onChangeText={setEditName}
            editable={isEditing}
            maxLength={100}
            style={[inputStyle, !isEditing && { opacity: 0.85 }]}
            placeholderTextColor={subTextColor}
          />

          {/* Personality / Description */}
          <Text style={labelStyle}>PERSONALITY</Text>
          <TextInput
            value={editPersonality}
            onChangeText={setEditPersonality}
            editable={isEditing}
            multiline
            style={[
              inputStyle,
              { minHeight: 80, textAlignVertical: 'top' },
              !isEditing && { opacity: 0.85 },
            ]}
            placeholderTextColor={subTextColor}
          />

          {/* Scenario */}
          {(editScenario.length > 0 || isEditing) && (
            <>
              <Text style={labelStyle}>SCENARIO (subtitle)</Text>
              <TextInput
                value={editScenario}
                onChangeText={setEditScenario}
                editable={isEditing}
                multiline
                style={[
                  inputStyle,
                  { minHeight: 50, textAlignVertical: 'top' },
                  !isEditing && { opacity: 0.85 },
                ]}
                placeholderTextColor={subTextColor}
              />
            </>
          )}

          {/* First message */}
          {(editFirstMessage.length > 0 || isEditing) && (
            <>
              <Text style={labelStyle}>FIRST MESSAGE (preview)</Text>
              <TextInput
                value={editFirstMessage}
                onChangeText={setEditFirstMessage}
                editable={isEditing}
                multiline
                style={[
                  inputStyle,
                  { minHeight: 60, textAlignVertical: 'top' },
                  !isEditing && { opacity: 0.85 },
                ]}
                placeholderTextColor={subTextColor}
              />
            </>
          )}

          {/* Conversation examples */}
          <Text style={labelStyle}>CONVERSATION EXAMPLES</Text>
          <TextInput
            value={editExamples}
            onChangeText={setEditExamples}
            editable={isEditing}
            multiline
            style={[
              inputStyle,
              { minHeight: 100, textAlignVertical: 'top', fontFamily: 'monospace' },
              !isEditing && { opacity: 0.85 },
            ]}
            placeholderTextColor={subTextColor}
          />

          {/* Import button */}
          <TouchableOpacity
            onPress={handleImportEdited}
            style={{
              backgroundColor: isDark ? '#FFFFFF' : '#000000',
              borderRadius: 10,
              paddingVertical: 14,
              alignItems: 'center',
              marginTop: 8,
              marginBottom: 24,
              flexDirection: 'row',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name="download-outline"
              size={18}
              color={isDark ? '#000000' : '#FFFFFF'}
              style={{ marginRight: 6 }}
            />
            <Text
              style={{
                color: isDark ? '#000000' : '#FFFFFF',
                fontWeight: 'bold',
                fontSize: 15,
              }}
            >
              Import Character
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
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
            maxHeight: '90%',
            minHeight: '70%',
            padding: 16,
          }}
        >
          {selectedItem ? (
            renderDetailView()
          ) : (
            <>
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <Text
              style={{ fontSize: 18, fontWeight: 'bold', color: textColor }}
            >
              Browse Characters
            </Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={textColor} />
            </TouchableOpacity>
          </View>

          {/* Subtitle */}
          <Text style={{ color: subTextColor, fontSize: 12, marginBottom: 12 }}>
            {hasSearched
              ? 'Search results from Chub.ai'
              : 'Popular characters from Chub.ai. Optimized for mobile LLMs.'}
          </Text>

          {/* Search bar */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search characters..."
              placeholderTextColor={subTextColor}
              onSubmitEditing={handleSearch}
              returnKeyType="search"
              style={{
                flex: 1,
                backgroundColor: inputBg,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
                color: textColor,
                borderWidth: 1,
                borderColor,
                fontSize: 15,
              }}
            />
            <TouchableOpacity
              onPress={handleSearch}
              disabled={loading}
              style={{
                marginLeft: 8,
                backgroundColor: isDark ? '#FFFFFF' : '#000000',
                borderRadius: 10,
                padding: 10,
                width: 42,
                height: 42,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {loading ? (
                <ActivityIndicator
                  size="small"
                  color={isDark ? '#000000' : '#FFFFFF'}
                />
              ) : (
                <Ionicons
                  name="search"
                  size={20}
                  color={isDark ? '#000000' : '#FFFFFF'}
                />
              )}
            </TouchableOpacity>
          </View>

          {/* Results */}
          {loading ? (
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <ActivityIndicator size="large" color={textColor} />
              <Text style={{ color: subTextColor, marginTop: 12, fontSize: 13 }}>
                {hasSearched ? 'Searching characters...' : 'Loading popular characters...'}
              </Text>
            </View>
          ) : results.length > 0 ? (
            <FlatList
              data={results}
              renderItem={renderItem}
              keyExtractor={(item) => item.id.toString()}
              showsVerticalScrollIndicator={false}
              removeClippedSubviews
              initialNumToRender={8}
              windowSize={7}
              maxToRenderPerBatch={6}
            />
          ) : (
            <View
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: subTextColor, textAlign: 'center' }}>
                No characters found.{'\n'}Try a different search.
              </Text>
            </View>
          )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
