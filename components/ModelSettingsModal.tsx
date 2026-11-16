// File: components/ModelSettingsModal.tsx

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  useColorScheme,
  Switch,
  ScrollView,
  Pressable,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '@/store';
import type { GenSettings, HardwareAccelMode, CharacterGreetingMode } from '@/store';
import LogsModal from '@/components/LogsModal';

/**
 * The settings modal takes a store-compatible GenSettings blob so adding
 * new fields to store/useGenSettingsSlice automatically propagates here
 * without a second type definition drifting out of sync.
 */
interface ModelSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  initialSettings: GenSettings;
  onSave: (updated: GenSettings) => void;
  /**
   * Whether the currently-loaded model's chat template actually respects
   * the `enable_thinking` flag. When false, the thinking toggle is hidden
   * because it would be a no-op on that model. When null (unknown / no
   * model loaded), the toggle is shown as a safe default.
   */
  thinkingSupported?: boolean | null;
}

const ModelSettingsModal: React.FC<ModelSettingsModalProps> = ({
  visible,
  onClose,
  initialSettings,
  onSave,
  thinkingSupported,
}) => {
  const colorScheme = useColorScheme();

  // For the pill-shaped button background/text color
  const buttonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const buttonTextColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  // Subscribe to comboModeEnabled so the expandable image-gen section
  // shows/hides immediately when the switch is toggled. The previous
  // `useStore.getState()` reads didn't subscribe, so the section only
  // flipped visible after an unrelated re-render.
  const comboModeEnabled = useStore((s) => s.comboModeEnabled);
  const setComboMode = useStore((s) => s.setComboMode);

  const [contextLength, setContextLength] = useState(
    initialSettings.contextLength.toString()
  );
  const [temperature, setTemperature] = useState(
    initialSettings.temperature.toString()
  );
  const [topP, setTopP] = useState(initialSettings.topP.toString());
  const [webContextChars, setWebContextChars] = useState(
    initialSettings.webContextChars.toString()
  );
  const [autocloseEnabled, setAutocloseEnabled] = useState(
    initialSettings.autocloseWebView
  );
  const [autoLoadLastModel, setAutoLoadLastModel] = useState(
    initialSettings.autoLoadLastModel ?? false
  );
  const [feedGeneratedImageToVision, setFeedGeneratedImageToVision] = useState(
    initialSettings.feedGeneratedImageToVision ?? true
  );
  const [logsOpen, setLogsOpen] = useState(false);
  const [speculativeDecoding, setSpeculativeDecoding] = useState(
    initialSettings.speculativeDecoding ?? false
  );
  const [enableThinking, setEnableThinking] = useState(
    initialSettings.enableThinking
  );
  const [hardwareAcceleration, setHardwareAcceleration] = useState<HardwareAccelMode>(
    initialSettings.hardwareAcceleration
  );
  const [characterGreeting, setCharacterGreeting] =
    useState<CharacterGreetingMode>(initialSettings.characterGreeting);

  // Combo image gen settings
  const [imageSettingsExpanded, setImageSettingsExpanded] = useState(false);
  const [comboImageSteps, setComboImageSteps] = useState(
    initialSettings.comboImageSteps?.toString() ?? '12'
  );
  const [comboImageCfgScale, setComboImageCfgScale] = useState(
    initialSettings.comboImageCfgScale?.toString() ?? '7.5'
  );
  const [comboImageSize, setComboImageSize] = useState(
    initialSettings.comboImageSize ?? 256
  );
  const [comboImageNegativePrompt, setComboImageNegativePrompt] = useState(
    initialSettings.comboImageNegativePrompt ?? 'blurry, low quality, distorted, deformed, ugly, bad anatomy'
  );

  // The modal stays mounted while hidden, so reload the fields each time
  // it opens: the store may have rehydrated since mount, and edits from
  // a previous Cancel must not linger.
  useEffect(() => {
    if (!visible) return;
    setContextLength(initialSettings.contextLength.toString());
    setTemperature(initialSettings.temperature.toString());
    setTopP(initialSettings.topP.toString());
    setWebContextChars(initialSettings.webContextChars.toString());
    setAutocloseEnabled(initialSettings.autocloseWebView);
    setAutoLoadLastModel(initialSettings.autoLoadLastModel ?? false);
    setFeedGeneratedImageToVision(initialSettings.feedGeneratedImageToVision ?? true);
    setSpeculativeDecoding(initialSettings.speculativeDecoding ?? false);
    setEnableThinking(initialSettings.enableThinking);
    setHardwareAcceleration(initialSettings.hardwareAcceleration);
    setCharacterGreeting(initialSettings.characterGreeting);
    setComboImageSteps(initialSettings.comboImageSteps?.toString() ?? '12');
    setComboImageCfgScale(initialSettings.comboImageCfgScale?.toString() ?? '7.5');
    setComboImageSize(initialSettings.comboImageSize ?? 256);
    setComboImageNegativePrompt(
      initialSettings.comboImageNegativePrompt ??
        'blurry, low quality, distorted, deformed, ugly, bad anatomy'
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleSave = () => {
    const parsedContext = parseInt(contextLength, 10);
    const parsedTemp = parseFloat(temperature);
    const parsedTopP = parseFloat(topP);
    const parsedWebChars = parseInt(webContextChars, 10);

    if (
      isNaN(parsedContext) ||
      isNaN(parsedTemp) ||
      isNaN(parsedTopP) ||
      isNaN(parsedWebChars) ||
      parsedContext < 1 ||
      parsedTemp < 0 ||
      parsedTemp > 2 ||
      parsedTopP < 0 ||
      parsedTopP > 1 ||
      parsedWebChars < 0
    ) {
      themedAlert(
        'Invalid Input',
        'Please ensure all fields have valid numeric values.'
      );
      return;
    }

    onSave({
      contextLength: parsedContext,
      temperature: parsedTemp,
      topP: parsedTopP,
      webContextChars: parsedWebChars,
      autocloseWebView: autocloseEnabled,
      enableThinking,
      hardwareAcceleration,
      characterGreeting,
      comboImageSteps: Math.max(1, Math.min(50, parseInt(comboImageSteps, 10) || 12)),
      comboImageCfgScale: Math.max(0, Math.min(20, parseFloat(comboImageCfgScale) || 7.5)),
      comboImageSize,
      comboImageNegativePrompt,
      autoLoadLastModel,
      feedGeneratedImageToVision,
      speculativeDecoding,
    });
    onClose();
  };

  return (
    <>
    <LogsModal visible={logsOpen} onClose={() => setLogsOpen(false)} />
    <Modal
      visible={visible}
      transparent
      // Fade animates only the opacity of a single node, which is much
      // cheaper than "slide" on tall modals with lots of children.
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent={true}
      // Hint to RN that the hidden modal can be torn down after close —
      // avoids keeping the whole subtree in the view hierarchy.
      hardwareAccelerated
    >
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 16,
        }}
      >
        {/* Backdrop captures taps outside the card. A Pressable is lighter
            than TouchableOpacity — no wrapping Animated.View, no opacity
            driver — and we only need the onPress behaviour. */}
        <Pressable
          onPress={onClose}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
          }}
        />
        <View
          style={{
            width: '92%',
            // Cap at 88% of the viewport so we never clip off-screen —
            // the old card sized to content and overflowed on phones
            // once we added the Hardware Accel + Character Greeting +
            // Combo image sections.
            maxHeight: '88%',
            borderRadius: 12,
            backgroundColor: colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF',
            overflow: 'hidden',
          }}
        >
          {/* Header (fixed) */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12,
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: 'bold',
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
              }}
            >
              Generation Settings
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Ionicons
                name="close-circle-outline"
                size={24}
                color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              />
            </TouchableOpacity>
          </View>

          {/* Scrollable body. keyboardShouldPersistTaps='handled' lets the
              user tap Save/Cancel without dismissing the keyboard first,
              and removeClippedSubviews trims the render tree for the
              parts currently scrolled out of view. */}
          <ScrollView
            style={{ flexGrow: 0 }}
            contentContainerStyle={{
              paddingHorizontal: 16,
              paddingBottom: 12,
            }}
            showsVerticalScrollIndicator
            keyboardShouldPersistTaps="handled"
            removeClippedSubviews
          >
          {/* Context Length */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Context Length
          </Text>
          <TextInput
            value={contextLength}
            onChangeText={setContextLength}
            keyboardType="number-pad"
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Temperature */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Temperature
          </Text>
          <TextInput
            value={temperature}
            onChangeText={setTemperature}
            keyboardType="decimal-pad"
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Top P */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Top P
          </Text>
          <TextInput
            value={topP}
            onChangeText={setTopP}
            keyboardType="decimal-pad"
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Web Context Characters */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 4,
            }}
          >
            Web Context Characters
          </Text>
          <TextInput
            value={webContextChars}
            onChangeText={setWebContextChars}
            keyboardType="number-pad"
            style={{
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              borderRadius: 6,
              padding: 8,
              marginBottom: 12,
              backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F5F5F5',
              color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          />

          {/* Autoclose Webview */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <Text
              style={{
                flex: 1,
                color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              }}
            >
              Autoclose Webview
            </Text>
            <Switch
              value={autocloseEnabled}
              onValueChange={setAutocloseEnabled}
            />
          </View>

          {/* Enable Thinking — hidden when the current model's template
              doesn't actually respect the flag (no-op on non-reasoning
              models like Gemma 3, Llama 3.x, Phi-4, Qwen 2.5) */}
          {thinkingSupported !== false && (
            <>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginBottom: 4,
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
                  }}
                >
                  Thinking Mode (Smart vs Fast)
                </Text>
                <Switch
                  value={enableThinking}
                  onValueChange={setEnableThinking}
                />
              </View>
              <Text
                style={{
                  color: colorScheme === 'dark' ? '#888888' : '#999999',
                  fontSize: 11,
                  marginBottom: 12,
                }}
              >
                ON: model thinks before answering (better quality, slower).
                OFF: faster, more direct responses. Works on Qwen3, DeepSeek-R1,
                Gemma 4, and GLM-4.5. Non-reasoning models ignore this setting.
              </Text>
            </>
          )}

          {/* Auto-load last model */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <Text
              style={{
                flex: 1,
                color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              }}
            >
              Auto-load last model on launch
            </Text>
            <Switch
              value={autoLoadLastModel}
              onValueChange={setAutoLoadLastModel}
            />
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            Reloads the last-used model when the app opens. Leave off if a model is crashing on load — that prevents the crash loop and lets you pick a different model.
          </Text>

          {/* View Logs — captured console output for sharing */}
          <TouchableOpacity
            onPress={() => setLogsOpen(true)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 8,
              backgroundColor: colorScheme === 'dark' ? '#2A2A2D' : '#F3F4F6',
              marginBottom: 12,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: colorScheme === 'dark' ? '#CCCCCC' : '#333333', fontWeight: '600' }}>
                View Logs
              </Text>
              <Text
                style={{
                  color: colorScheme === 'dark' ? '#888888' : '#999999',
                  fontSize: 11,
                  marginTop: 2,
                }}
              >
                Recent console output. Tap Copy / Share to send a snippet.
              </Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colorScheme === 'dark' ? '#888' : '#666'}
            />
          </TouchableOpacity>

          {/* Feed generated image to vision LLM (combo mode) */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <Text
              style={{
                flex: 1,
                color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              }}
            >
              Send generated image to vision model
            </Text>
            <Switch
              value={feedGeneratedImageToVision}
              onValueChange={setFeedGeneratedImageToVision}
            />
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            Combo mode only. After image gen, attach the image to the next user turn so a vision-capable LLM can actually see it. Costs one CLIP encoder pass on that next turn only. Off keeps things faster but the model only knows what it generated by its prompt.
          </Text>

          {/* Speculative decoding (MTP) */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <Text
              style={{
                flex: 1,
                color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              }}
            >
              Speculative decoding (MTP)
            </Text>
            <Switch
              value={speculativeDecoding}
              onValueChange={setSpeculativeDecoding}
            />
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            Experimental. Models with a built-in prediction head (MTP builds) draft a few tokens ahead and keep the ones the full model agrees with. Other models ignore this. In testing it was slower when the model runs on CPU, so it is off by default. Applies the next time the model loads.
          </Text>

          {/* Hardware Acceleration */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 6,
            }}
          >
            Hardware Acceleration
          </Text>
          <View
            style={{
              flexDirection: 'row',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              overflow: 'hidden',
              marginBottom: 4,
            }}
          >
            {(['auto', 'cpu', 'gpu', 'npu'] as HardwareAccelMode[]).map((mode) => {
              const selected = hardwareAcceleration === mode;
              const label = mode === 'auto' ? 'Auto' : mode.toUpperCase();
              return (
                <TouchableOpacity
                  key={mode}
                  onPress={() => setHardwareAcceleration(mode)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    alignItems: 'center',
                    backgroundColor: selected
                      ? (colorScheme === 'dark' ? '#FFFFFF' : '#000000')
                      : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: selected ? 'bold' : 'normal',
                      color: selected
                        ? (colorScheme === 'dark' ? '#000000' : '#FFFFFF')
                        : (colorScheme === 'dark' ? '#CCCCCC' : '#333333'),
                    }}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            {hardwareAcceleration === 'auto'
              ? 'Automatically selects the best available backend: NPU (Hexagon) > GPU (Adreno OpenCL) > CPU. Recommended for most users.'
              : hardwareAcceleration === 'cpu'
              ? 'CPU only. Safest option, works with all models and devices.'
              : hardwareAcceleration === 'gpu'
              ? 'Adreno GPU via OpenCL. Only Q4_0 / Q6_K models are reliable — others fall back to CPU. May crash on some devices.'
              : 'Qualcomm Hexagon NPU. Requires a Snapdragon SoC with HTP support. Falls back to GPU or CPU if unavailable.'}
          </Text>

          {/* Character Greeting */}
          <Text
            style={{
              color: colorScheme === 'dark' ? '#CCCCCC' : '#333333',
              marginBottom: 6,
            }}
          >
            Character Greeting
          </Text>
          <View
            style={{
              flexDirection: 'row',
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colorScheme === 'dark' ? '#444444' : '#CCCCCC',
              overflow: 'hidden',
              marginBottom: 4,
            }}
          >
            {(
              [
                { value: 'scripted', label: 'Scripted' },
                { value: 'llm', label: 'LLM' },
                { value: 'off', label: 'Off' },
              ] as { value: CharacterGreetingMode; label: string }[]
            ).map(({ value, label }) => {
              const selected = characterGreeting === value;
              return (
                <TouchableOpacity
                  key={value}
                  onPress={() => setCharacterGreeting(value)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    alignItems: 'center',
                    backgroundColor: selected
                      ? (colorScheme === 'dark' ? '#FFFFFF' : '#000000')
                      : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: selected ? 'bold' : 'normal',
                      color: selected
                        ? (colorScheme === 'dark' ? '#000000' : '#FFFFFF')
                        : (colorScheme === 'dark' ? '#CCCCCC' : '#333333'),
                    }}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            {characterGreeting === 'scripted'
              ? 'Scripted: use the card\u2019s first_message if it has one, otherwise the model generates a short opener. Recommended for Chub.ai cards with crafted openings.'
              : characterGreeting === 'llm'
              ? 'LLM: the model always generates the opener from the full persona context (including any scripted first_message) and replies first. Use this if you want a fresh scene every activation and a warmed context before you type.'
              : 'Off: no auto-greeting. Cheap cache-warm only \u2014 you send the first message.'}
          </Text>

          {/* ─── Combo Mode ─────────────────────────────── */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <Text
              style={{
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                fontSize: 14,
                fontWeight: '600',
              }}
            >
              Combo Mode (Text + Image)
            </Text>
            <Switch
              value={comboModeEnabled}
              onValueChange={setComboMode}
            />
          </View>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#888888' : '#999999',
              fontSize: 11,
              marginBottom: 12,
            }}
          >
            Load both a text model and an image generation model at the same time. During chat, characters can send photos inline. Select one text model and one image model from the model list.
          </Text>

          {/* ─── Image Generation Settings (expandable, combo mode only) ── */}
          {comboModeEnabled && (
            <>
              <TouchableOpacity
                onPress={() => setImageSettingsExpanded((p) => !p)}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: imageSettingsExpanded ? 8 : 12,
                  paddingVertical: 4,
                }}
              >
                <Text
                  style={{
                    color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                    fontSize: 14,
                    fontWeight: '600',
                  }}
                >
                  Image Generation Settings
                </Text>
                <Ionicons
                  name={imageSettingsExpanded ? 'chevron-up' : 'chevron-down'}
                  size={18}
                  color={colorScheme === 'dark' ? '#888888' : '#666666'}
                />
              </TouchableOpacity>
              {imageSettingsExpanded && (
                <View style={{ marginBottom: 12 }}>
                  {/* Steps */}
                  <Text style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000', fontSize: 13, marginBottom: 4 }}>
                    Steps
                  </Text>
                  <TextInput
                    value={comboImageSteps}
                    onChangeText={setComboImageSteps}
                    keyboardType="number-pad"
                    style={{
                      borderWidth: 1,
                      borderColor: colorScheme === 'dark' ? '#555' : '#CCC',
                      borderRadius: 8,
                      padding: 8,
                      color: colorScheme === 'dark' ? '#FFF' : '#000',
                      marginBottom: 8,
                    }}
                    placeholder="12"
                    placeholderTextColor="#888"
                  />

                  {/* CFG Scale */}
                  <Text style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000', fontSize: 13, marginBottom: 4 }}>
                    CFG Scale
                  </Text>
                  <TextInput
                    value={comboImageCfgScale}
                    onChangeText={setComboImageCfgScale}
                    keyboardType="decimal-pad"
                    style={{
                      borderWidth: 1,
                      borderColor: colorScheme === 'dark' ? '#555' : '#CCC',
                      borderRadius: 8,
                      padding: 8,
                      color: colorScheme === 'dark' ? '#FFF' : '#000',
                      marginBottom: 8,
                    }}
                    placeholder="7.5"
                    placeholderTextColor="#888"
                  />

                  {/* Image Size */}
                  <Text style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000', fontSize: 13, marginBottom: 4 }}>
                    Image Size
                  </Text>
                  <View style={{ flexDirection: 'row', marginBottom: 8, gap: 8 }}>
                    {[256, 384, 512].map((size) => (
                      <TouchableOpacity
                        key={size}
                        onPress={() => setComboImageSize(size)}
                        style={{
                          paddingVertical: 6,
                          paddingHorizontal: 14,
                          borderRadius: 16,
                          backgroundColor:
                            comboImageSize === size
                              ? (colorScheme === 'dark' ? '#FFFFFF' : '#000000')
                              : (colorScheme === 'dark' ? '#333' : '#E5E5E5'),
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: '600',
                            color:
                              comboImageSize === size
                                ? (colorScheme === 'dark' ? '#000000' : '#FFFFFF')
                                : (colorScheme === 'dark' ? '#AAA' : '#666'),
                          }}
                        >
                          {size}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* Negative Prompt */}
                  <Text style={{ color: colorScheme === 'dark' ? '#FFFFFF' : '#000000', fontSize: 13, marginBottom: 4 }}>
                    Negative Prompt
                  </Text>
                  <TextInput
                    value={comboImageNegativePrompt}
                    onChangeText={setComboImageNegativePrompt}
                    multiline
                    numberOfLines={2}
                    style={{
                      borderWidth: 1,
                      borderColor: colorScheme === 'dark' ? '#555' : '#CCC',
                      borderRadius: 8,
                      padding: 8,
                      color: colorScheme === 'dark' ? '#FFF' : '#000',
                      minHeight: 50,
                    }}
                    placeholder="blurry, low quality, distorted..."
                    placeholderTextColor="#888"
                  />
                  <Text
                    style={{
                      color: colorScheme === 'dark' ? '#888888' : '#999999',
                      fontSize: 11,
                      marginTop: 4,
                    }}
                  >
                    These settings apply to images generated in combo mode (both inline via chat and the manual image button).
                  </Text>
                </View>
              )}
            </>
          )}

          </ScrollView>

          {/* Footer Buttons (Cancel | Save) — fixed outside the scroll
              area so Save is always reachable even on short screens. */}
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'flex-end',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderTopWidth: 1,
              borderTopColor: colorScheme === 'dark' ? '#2C2C2E' : '#EEEEEE',
            }}
          >
            <TouchableOpacity
              onPress={onClose}
              style={{
                marginRight: 16,
                paddingVertical: 8,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ color: colorScheme === 'dark' ? '#888888' : '#888888' }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSave}
              style={{
                paddingVertical: 8,
                paddingHorizontal: 16,
                borderRadius: 999,
                backgroundColor: buttonBg,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: buttonTextColor, fontWeight: 'bold' }}>
                Save
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
    </>
  );
};

export default ModelSettingsModal;
