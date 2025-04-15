// app/(root)/(tabs)/home.tsx

import React, { useState, useEffect, useRef } from 'react';
import {
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  useColorScheme,
  NativeSyntheticEvent,
  TextInputContentSizeChangeEventData,
  Animated,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  UIManager,
  KeyboardEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Entypo from '@expo/vector-icons/Entypo';

import { useStore } from '@/store';
import DownloadModel from '@/components/DownloadModel';
import ModelSettingsModal from '@/components/ModelSettingsModal'; // <-- import
import { initLlama, LlamaContext, RNLlamaOAICompatibleMessage } from 'llama.rn';
import * as FileSystem from 'expo-file-system';
import { Bar } from 'react-native-progress';
import ChatSessionsList from '@/components/ChatHistoryModal';

// ===== Added KeepAwake =====
import { useKeepAwake } from 'expo-keep-awake'; // <-- keeps device awake

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Standard stop words that Llama may append at the very end
const STANDARD_STOP_WORDS = [
  '</s>',
  '<|end|>',
  '<|eot_id|>',
  '<|end_of_text|>',
  '<|im_end|>',
  '<|EOT|>',
  '<|END_OF_TURN_TOKEN|>',
  '<|end_of_turn|>',
  '<|endoftext|>',
  '<|end_of_sentence|>',
  '<eos>',
  '<end_of_turn>',
];

type ChatMessage = {
  id: string;
  sender: 'User' | 'Model';
  message: string;
  isStreaming?: boolean;
};

function partialCleanup(text: string) {
  let out = text.normalize('NFKC');
  out = out.replace(/<[^>]*(?:end_of_sentence|end▁of▁sentence)[^>]*>/gi, '');
  return out;
}

function finalCleanup(text: string) {
  let clean = text.normalize('NFKC').trim();
  clean = clean.replace(
    /<[^>]*(?:end_of_sentence|end▁of▁sentence)[^>]*>/gi,
    ''
  );

  const removeTrailingStopWords = () => {
    let keepChecking = true;
    while (keepChecking) {
      keepChecking = false;
      for (const sw of STANDARD_STOP_WORDS) {
        const trimmed = clean.trimEnd();
        if (trimmed.endsWith(sw)) {
          clean = trimmed.slice(0, -sw.length).trimEnd();
          keepChecking = true;
          break;
        }
      }
    }
  };
  removeTrailingStopWords();

  return clean;
}

function parseThinkTags(
  message: string
): Array<{ type: 'think' | 'text'; content: string }> {
  const segments: { type: 'think' | 'text'; content: string }[] = [];
  let remaining = message;

  while (true) {
    const startIndex = remaining.indexOf('<think>');
    if (startIndex === -1) {
      if (remaining) {
        segments.push({ type: 'text', content: remaining });
      }
      break;
    }

    if (startIndex > 0) {
      segments.push({ type: 'text', content: remaining.slice(0, startIndex) });
    }

    const endIndex = remaining.indexOf('</think>', startIndex);
    if (endIndex === -1) {
      const thinkContent = remaining.slice(startIndex + 7);
      segments.push({ type: 'think', content: thinkContent });
      break;
    } else {
      const thinkContent = remaining.slice(startIndex + 7, endIndex);
      segments.push({ type: 'think', content: thinkContent });
      remaining = remaining.slice(endIndex + 8);
    }
  }

  return segments;
}

const TypingIndicator = ({ anim }: { anim: Animated.Value }) => {
  return (
    <Animated.View
      style={{
        flexDirection: 'row',
        marginTop: 4,
        opacity: anim,
      }}
    >
      <View className="w-2 h-2 bg-gray-400 rounded-full mr-1" />
      <View className="w-2 h-2 bg-gray-400 rounded-full mr-1" />
      <View className="w-2 h-2 bg-gray-400 rounded-full" />
    </Animated.View>
  );
};

const Home: React.FC = () => {
  const {
    selectedModel,
    activeCharacter,
    chatHistory,
    addChatMessage,
    updateChatMessage,
    clearAllSessions,
    startNewSessionOnAppOpen,
    startNewSession,
    isDownloading,
    downloadProgress,
    currentDownloadModelName,
    cancelDownload,
    selectModel,
    lastUsedModelName,
    setLastUsedModelName,
    downloadedModels,
    models,
  } = useStore();

  // ===== Keep the screen awake while on this component =====
  // This is optional; remove if you don't want to force screen on.
  useKeepAwake();

  const [llamaContext, setLlamaContext] = useState<LlamaContext | null>(null);
  const [inputText, setInputText] = useState('');
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);

  const [inputHeight, setInputHeight] = useState(40);

  // Generation settings
  const [genSettings, setGenSettings] = useState({
    contextLength: 2048,
    temperature: 0.7,
    topP: 0.95,
  });
  const [isModelSettingsModalVisible, setIsModelSettingsModalVisible] =
    useState(false);

  // The 3-dot vertical popover
  const [isSettingsMenuVisible, setIsSettingsMenuVisible] = useState(false);

  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const colorScheme = useColorScheme() || 'light';
  const placeholderColor = colorScheme === 'dark' ? '#E6E6E6' : '#666666';
  const spinnerColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  const generationIdRef = useRef<number>(0);

  const typingAnim = useRef(new Animated.Value(0)).current;

  // Drawer
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const screenWidth = Dimensions.get('window').width;
  const drawerWidth = screenWidth * 0.75;
  const drawerAnim = useRef(new Animated.Value(-drawerWidth)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const homeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const handleKeyboardWillShow = (e: KeyboardEvent) => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    };
    const handleKeyboardWillHide = (e: KeyboardEvent) => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    };

    const showSub = Keyboard.addListener(
      'keyboardWillShow',
      handleKeyboardWillShow
    );
    const hideSub = Keyboard.addListener(
      'keyboardWillHide',
      handleKeyboardWillHide
    );

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    startNewSession();
    startNewSessionOnAppOpen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedModel && lastUsedModelName) {
      const isDownloaded = downloadedModels.includes(
        `${lastUsedModelName}.gguf`
      );
      if (isDownloaded) {
        const fallback = models.find((m) => m.name === lastUsedModelName);
        if (fallback) {
          selectModel(fallback);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedModel) {
      (async () => {
        const success = await loadModel(selectedModel);
        generationIdRef.current += 1;
        if (!success) {
          selectModel(null);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  useEffect(() => {
    return () => {
      unloadModel();
    };
  }, []);

  useEffect(() => {
    if (isGenerating) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(typingAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(typingAnim, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      typingAnim.setValue(0);
    }
  }, [isGenerating]);

  const openDrawer = () => {
    setIsDrawerOpen(true);
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0.5,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(homeAnim, {
        toValue: drawerWidth,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const closeDrawer = () => {
    Animated.parallel([
      Animated.timing(drawerAnim, {
        toValue: -drawerWidth,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(homeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setIsDrawerOpen(false);
    });
  };

  const loadModel = async (model: typeof selectedModel): Promise<boolean> => {
    if (!model) return false;
    unloadModel();

    try {
      setIsModelLoading(true);
      // We’ll point to the final .gguf (NOT the .part)
      const modelPath = `${FileSystem.documentDirectory}Downloads/${model.name}.gguf`;

      const fileInfo = await FileSystem.getInfoAsync(modelPath);
      if (!fileInfo.exists) {
        Alert.alert(
          'Model Not Found',
          `The model "${model.name}" is not fully downloaded.`
        );
        return false;
      }

      const context = await initLlama({
        model: modelPath,
        use_mlock: true,
        n_ctx: 2048,
        n_gpu_layers: 1,
      });
      setLlamaContext(context);

      setLastUsedModelName(model.name);
      startNewSession();
      return true;
    } catch (err) {
      console.error('Error loading model:', err);
      Alert.alert(
        'Error',
        'Failed to load the model. Possibly incomplete or corrupted?'
      );
      return false;
    } finally {
      setIsModelLoading(false);
    }
  };

  const unloadModel = () => {
    if (llamaContext) {
      llamaContext.stopCompletion();
      llamaContext.release();
      setLlamaContext(null);
    }
  };

  const handleEjectModel = (modelName: string) => {
    if (selectedModel?.name === modelName) {
      unloadModel();
      selectModel(null);
    }
  };

  const handleStopGeneration = () => {
    if (llamaContext) {
      llamaContext.stopCompletion();
    }
    setIsGenerating(false);
  };

  const handleSendOrStop = async () => {
    if (isGenerating) {
      handleStopGeneration();
      return;
    }
    if (!inputText.trim()) return;
    if (!selectedModel || !llamaContext) {
      Alert.alert('No model loaded', 'Please select a model first.');
      return;
    }

    llamaContext.stopCompletion();
    const currentGenId = generationIdRef.current + 1;
    generationIdRef.current = currentGenId;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      sender: 'User',
      message: inputText.trim(),
    };
    addChatMessage(userMessage);
    setInputText('');
    setInputHeight(40);
    setIsGenerating(true);

    const botMessageId = (Date.now() + 1).toString();
    addChatMessage({
      id: botMessageId,
      sender: 'Model',
      message: '',
      isStreaming: true,
    });

    try {
      const { activeCharacter } = useStore.getState();
      let systemMessage: RNLlamaOAICompatibleMessage = {
        role: 'system',
        content: 'You are a helpful assistant.',
      };
      if (activeCharacter) {
        systemMessage = {
          role: 'system',
          content: `
You are acting as the character "${activeCharacter.name}".
Character Description: ${activeCharacter.description}
Conversation Style: ${activeCharacter.conversationStyle}
        `.trim(),
        };
      }

      const messages: RNLlamaOAICompatibleMessage[] = [
        systemMessage,
        ...chatHistory.map((entry) => ({
          role: entry.sender === 'User' ? 'user' : 'assistant',
          content: entry.message,
        })),
        {
          role: 'user',
          content: userMessage.message,
        },
      ];

      // Use the custom genSettings
      const result = await llamaContext.completion(
        {
          messages,
          n_predict: genSettings.contextLength,
          stop: STANDARD_STOP_WORDS,
          temperature: genSettings.temperature,
          top_p: genSettings.topP,
        },
        (data) => {
          const { token } = data;
          updateChatMessage(botMessageId, (prev) => {
            const partial = prev.message + token;
            const cleanedPartial = partialCleanup(partial);
            return {
              ...prev,
              message: cleanedPartial,
            };
          });
        }
      );

      if (currentGenId !== generationIdRef.current) {
        updateChatMessage(botMessageId, { message: '', isStreaming: false });
        return;
      }

      let finalText = finalCleanup(result.text);
      updateChatMessage(botMessageId, {
        message: finalText,
        isStreaming: false,
      });

      flatListRef.current?.scrollToEnd({ animated: true });
    } catch (error) {
      console.error('Error generating response:', error);
      Alert.alert('Error', 'Failed to generate a response.');
      updateChatMessage(botMessageId, { message: '', isStreaming: false });
    } finally {
      if (currentGenId === generationIdRef.current) {
        setIsGenerating(false);
      }
    }
  };

  const handleNewChat = () => {
    if (llamaContext) {
      llamaContext.stopCompletion();
    }
    generationIdRef.current += 1;
    setIsGenerating(false);
    startNewSession();
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    if (item.sender === 'User') {
      return (
        <View className="self-end p-3 m-2 max-w-2/3 rounded-2xl bg-theme-light-input-background dark:bg-theme-dark-input-background">
          <Text className="text-lg text-theme-light-text-primary dark:text-theme-dark-text-primary">
            {item.message}
          </Text>
        </View>
      );
    } else {
      const segments = parseThinkTags(item.message || '');
      return (
        <View className="self-start p-3 m-2 w-full rounded-xl bg-transparent">
          {segments.map((seg, index) => {
            if (seg.type === 'think') {
              return (
                <View key={index} className="flex-row my-2">
                  <View className="w-1 bg-gray-500 rounded-l-full" />
                  <View className="flex-1 ml-2">
                    <Text className="italic text-gray-500">{seg.content}</Text>
                  </View>
                </View>
              );
            } else {
              return (
                <Text
                  key={index}
                  className="text-lg text-theme-light-text-primary dark:text-theme-dark-text-primary"
                >
                  {seg.content}
                </Text>
              );
            }
          })}
          {item.isStreaming && <TypingIndicator anim={typingAnim} />}
        </View>
      );
    }
  };

  const overallDownloadProgress = () => {
    const downloadingModels = Object.keys(downloadProgress).filter(
      (modelName) => downloadProgress[modelName] < 1
    );
    if (downloadingModels.length === 0) return 0;
    const totalProgress = downloadingModels.reduce(
      (acc, modelName) => acc + downloadProgress[modelName],
      0
    );
    return totalProgress / downloadingModels.length;
  };

  const handleCancelDownload = () => {
    if (currentDownloadModelName) {
      cancelDownload(currentDownloadModelName);
    }
  };

  const onInputSizeChange = (
    e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) => {
    const newHeight = e.nativeEvent.contentSize.height;
    const maxHeight = 6 * 40;
    const adjustedHeight = newHeight < 48 ? 40 : newHeight;
    setInputHeight(Math.min(adjustedHeight, maxHeight));
  };

  const isEmpty = chatHistory.length === 0;
  const headerTitle = activeCharacter
    ? activeCharacter.name
    : selectedModel
      ? selectedModel.name
      : 'Select Model';

  const arrowButtonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const arrowIconColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';
  const createChatIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      className="flex-1 bg-theme-light-background dark:bg-theme-dark-background"
    >
      <Animated.View
        style={{
          flex: 1,
          transform: [{ translateX: homeAnim }],
        }}
      >
        {/* Header */}
        <View className="flex-row justify-between items-center p-4">
          {/* Drawer button */}
          <TouchableOpacity
            onPress={openDrawer}
            style={{ marginRight: 16 }}
            hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
          >
            <Entypo
              name="list"
              size={28}
              color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
            />
          </TouchableOpacity>

          {/* Title + model selection dropdown */}
          <TouchableOpacity
            onPress={() => setIsModalVisible(true)}
            className="flex-row items-center"
            style={{ flex: 1 }}
          >
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              className="text-xl font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary"
              style={{
                opacity: isModelLoading ? 0.5 : 1,
                maxWidth: 140,
              }}
            >
              {headerTitle}
            </Text>
            <MaterialIcons
              name="arrow-drop-down"
              size={24}
              color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              style={{ marginLeft: 4 }}
            />
          </TouchableOpacity>

          {/* New Chat icon */}
          <TouchableOpacity
            onPress={handleNewChat}
            style={{ marginLeft: 12 }}
            className="flex-row items-center"
          >
            <Ionicons
              name="create-outline"
              size={28}
              color={createChatIconColor}
            />
          </TouchableOpacity>

          {/* 3-dot vertical icon for "Gen Settings" menu */}
          <TouchableOpacity
            onPress={() => setIsSettingsMenuVisible(!isSettingsMenuVisible)}
            style={{ marginLeft: 12 }}
          >
            <Ionicons
              name="ellipsis-vertical"
              size={24}
              color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
            />
          </TouchableOpacity>
        </View>

        {/* If isSettingsMenuVisible => show the popover. Wrap it in a big touchable. */}
        {isSettingsMenuVisible && (
          <>
            {/* An invisible overlay behind the menu. Press => closes. */}
            <TouchableOpacity
              onPress={() => setIsSettingsMenuVisible(false)}
              activeOpacity={1}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 10,
              }}
            />

            {/* The actual small menu */}
            <View
              style={{
                position: 'absolute',
                top: 60,
                right: 20,
                backgroundColor: colorScheme === 'dark' ? '#333' : '#fff',
                borderRadius: 8,
                padding: 8,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.3,
                shadowRadius: 4,
                zIndex: 11,
              }}
            >
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 6,
                }}
                onPress={() => {
                  setIsSettingsMenuVisible(false);
                  setIsModelSettingsModalVisible(true);
                }}
              >
                <Ionicons
                  name="settings-outline"
                  size={18}
                  color={colorScheme === 'dark' ? '#fff' : '#000'}
                  style={{ marginRight: 8 }}
                />
                <Text
                  style={{
                    color: colorScheme === 'dark' ? '#fff' : '#000',
                  }}
                >
                  Gen Settings
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {isModelLoading && (
          <View className="px-4 flex-row items-center mb-2">
            <ActivityIndicator size="small" color={spinnerColor} />
            <Text className="ml-2 text-theme-light-text-secondary dark:text-theme-dark-text-secondary">
              Loading model...
            </Text>
          </View>
        )}

        {isDownloading && (
          <View className="px-4 flex-row items-center">
            <View className="flex-1 mr-2">
              <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mb-1">
                Downloading: {(overallDownloadProgress() * 100).toFixed(0)}%
              </Text>
              <Bar
                progress={overallDownloadProgress()}
                width={null}
                color="#666666"
                unfilledColor="#E3E3E3"
              />
            </View>
            <TouchableOpacity
              onPress={handleCancelDownload}
              className="justify-center items-center"
            >
              <Ionicons name="close-circle" size={26} color="#666666" />
            </TouchableOpacity>
          </View>
        )}

        {isEmpty ? (
          <View
            style={{
              flex: 1,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Text
              style={{
                fontSize: 24,
                textAlign: 'center',
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
              }}
            >
              What can I help with?
            </Text>
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={chatHistory}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            className="flex-1 px-4"
            contentContainerStyle={{ paddingBottom: 16 }}
            onContentSizeChange={() =>
              flatListRef.current?.scrollToEnd({ animated: true })
            }
            onLayout={() =>
              flatListRef.current?.scrollToEnd({ animated: true })
            }
          />
        )}

        {/* Keyboard offset */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={60}
          style={{
            backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#FCFCFC',
          }}
        >
          <View
            className="flex-row items-center rounded-[1.9rem] m-4 px-4"
            style={{
              backgroundColor: colorScheme === 'dark' ? '#242424' : '#F0F0F0',
              minHeight: 40,
              height: inputHeight + 16,
              maxHeight: 6 * 40 + 16,
            }}
          >
            <TextInput
              className="flex-1 text-lg text-theme-light-input-text dark:text-theme-dark-input-text"
              placeholder="Ask anything..."
              placeholderTextColor={placeholderColor}
              multiline
              onContentSizeChange={onInputSizeChange}
              value={inputText}
              onChangeText={setInputText}
              selectionColor="#FFFFFF"
              style={{
                paddingVertical: 8,
                height: inputHeight,
              }}
              keyboardAppearance={colorScheme === 'dark' ? 'dark' : 'light'}
            />

            <TouchableOpacity
              onPress={handleSendOrStop}
              disabled={!llamaContext || !selectedModel}
              style={{
                marginLeft: 8,
                padding: 8,
                borderRadius: 999,
                backgroundColor:
                  !llamaContext || !selectedModel ? '#A0A0A0' : arrowButtonBg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons
                name={isGenerating ? 'stop' : 'arrow-up'}
                size={20}
                color={
                  !llamaContext || !selectedModel ? '#666666' : arrowIconColor
                }
              />
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Animated.View>

      {/* Download model modal */}
      <DownloadModel
        visible={isModalVisible}
        onClose={() => setIsModalVisible(false)}
        onUseModel={(modelName: string) => {
          generationIdRef.current += 1;
          setIsGenerating(false);
          const store = useStore.getState();
          const foundModel = store.models.find((m) => m.name === modelName);
          if (foundModel) {
            store.selectModel(foundModel);
          }
          setIsModalVisible(false);
        }}
        onEjectModel={handleEjectModel}
      />

      {/* Model Settings Modal */}
      <ModelSettingsModal
        visible={isModelSettingsModalVisible}
        onClose={() => setIsModelSettingsModalVisible(false)}
        initialSettings={genSettings}
        onSave={(updated) => {
          setGenSettings(updated);
        }}
      />

      {/* Drawer overlay */}
      <Animated.View
        pointerEvents={isDrawerOpen ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: '#000',
          opacity: overlayAnim,
        }}
      >
        <TouchableOpacity style={{ flex: 1 }} onPress={closeDrawer} />
      </Animated.View>

      {/* Drawer content */}
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: drawerWidth,
          backgroundColor: colorScheme === 'dark' ? '#0D0D0D' : '#ffffff',
          transform: [{ translateX: drawerAnim }],
        }}
      >
        <ChatSessionsList />
      </Animated.View>
    </SafeAreaView>
  );
};

export default Home;
