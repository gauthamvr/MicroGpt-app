// components/ImageGenerationView.tsx
//
// Drop-in chat replacement for Stable Diffusion image generation models.
// When home.tsx detects the selected model is of type `imageGen`, it
// renders <ImageGenerationView /> instead of the chat flow. The component
// owns its own load/generate/unload lifecycle so home.tsx doesn't need to
// know which engine runs — it just hands over the model file path.
//
// The surface is deliberately similar to the chat input bar (prompt on
// the bottom, big-send button on the right) so there's no jarring UX
// shift when switching between text and image models. Differences:
//   - no globe/internet toggle (image models don't use web context)
//   - no camera/vision button
//   - an extra negative-prompt input expandable via a small chevron
//   - result surface is a single large image tile with a share menu
//   - a progress bar tracks diffusion steps during generation

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { getModelsDir } from '@/lib/storage-paths';
import { themedAlert } from '@/components/ThemedAlert';
import { useStore, Model } from '@/store';
import * as ImageGenService from '@/lib/image-gen-service';
import { isContentBlocked } from '@/lib/content-safety';
import { promptReport } from '@/lib/content-report';

type Props = {
  model: Model;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Recommended (steps, cfg) defaults by model family. Turbo and LCM
 * variants only need 1-8 steps — keeping the defaults in sync with the
 * underlying model avoids wasted inference time and matches what the
 * model was actually trained for.
 */
function pickDefaults(modelName: string): { steps: number; cfg: number } {
  const lower = modelName.toLowerCase();
  if (lower.includes('turbo')) return { steps: 4, cfg: 1.0 };
  if (lower.includes('lcm')) return { steps: 6, cfg: 2.0 };
  // Default 12 steps — 8 gave "somewhat similar" results, 12 should
  // produce clearly recognizable images. With Vulkan GPU acceleration
  // this will be fast; on CPU it's ~4 min at 256x256.
  return { steps: 12, cfg: 7.5 };
}

const ImageGenerationView: React.FC<Props> = ({ model }) => {
  const cs = useColorScheme();
  const isDark = cs === 'dark';
  // Narrow selector — bare useStore() here subscribed this screen to
  // the whole store, so any streaming tokens on Home (in combo mode)
  // would re-render it on every flush.
  const addChatMessage = useStore((s) => s.addChatMessage);

  // Theme tokens — match the app's existing palette
  const bgColor = isDark ? '#0D0D0D' : '#FCFCFC';
  const cardBg = isDark ? '#242424' : '#F0F0F0';
  const inputBg = isDark ? '#242424' : '#F0F0F0';
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const subTextColor = isDark ? '#9BA1A6' : '#6B7280';
  const borderColor = isDark ? '#3A3A3C' : '#E5E5EA';
  const accentBg = isDark ? '#FFFFFF' : '#000000';
  const accentFg = isDark ? '#000000' : '#FFFFFF';
  const placeholderColor = isDark ? '#888888' : '#AAAAAA';

  const defaults = pickDefaults(model.name);

  // QNN/NPU graphs (Android) and Core ML pipelines (iOS) are baked at a
  // fixed 512×512 latent shape — any other size produces wrong-shape
  // output. For those models we default the size to 512 and lock the
  // picker to that single value.
  const isNpu = ImageGenService.isFixedSizeModel(model.name);

  // ─── State ──────────────────────────────────────────────────────
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  // Default negative prompt improves quality significantly by telling
  // the model what to avoid. This is standard practice for SD 1.5.
  const [negativePrompt, setNegativePrompt] = useState(
    'blurry, low quality, distorted, deformed, ugly, bad anatomy'
  );
  const [showNegative, setShowNegative] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [steps, setSteps] = useState(defaults.steps);
  const [cfgScale, setCfgScale] = useState(defaults.cfg);
  // NPU models are locked at 512. For MNN/CPU models default to 256
  // for fastest generation — quality depends more on the model and
  // step count than resolution for prompt adherence.
  const [imageSize, setImageSize] = useState(isNpu ? 512 : 256);

  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [result, setResult] = useState<string | null>(null); // base64 PNG
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [genElapsed, setGenElapsed] = useState(0);
  const [activeBackend, setActiveBackend] = useState<string>('');
  const [lastGenTime, setLastGenTime] = useState<number>(0);

  const genCancelled = useRef(false);
  const genTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genStartRef = useRef(0);

  // ─── Load model on mount / model change ─────────────────────────
  useEffect(() => {
    let cancelled = false;

    const binaryError = ImageGenService.diagnoseBinary();
    if (binaryError) {
      console.error('[ImageGen] LOAD ERROR:', binaryError);
      setLoadState('error');
      setLoadError(binaryError);
      return;
    }

    (async () => {
      console.log('[ImageGen] Loading model:', model.name);
      setLoadState('loading');
      setLoadError(null);
      try {
        await ImageGenService.loadImageModel(model.name);
        if (cancelled) return;
        console.log('[ImageGen] Model loaded, server ready');
        setLoadState('ready');
      } catch (err: any) {
        if (cancelled) return;
        const msg = err?.message ?? String(err);
        console.error('[ImageGen] LOAD FAILED:', msg);
        setLoadState('error');
        setLoadError(msg);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [model.name]);

  // Unload when unmounting (i.e. switching away from this model)
  useEffect(() => {
    return () => {
      void ImageGenService.unloadImageModel().catch(() => {});
    };
  }, []);

  // Clear the elapsed-time interval on unmount — the finally block in
  // handleGenerate handles the normal-completion path, but if the user
  // navigates away mid-generation that block doesn't run and the timer
  // would keep firing setGenElapsed on an unmounted component.
  useEffect(() => {
    return () => {
      if (genTimerRef.current) {
        clearInterval(genTimerRef.current);
        genTimerRef.current = null;
      }
    };
  }, []);

  // ─── Progress listener ──────────────────────────────────────────
  useEffect(() => {
    const sub = ImageGenService.addProgressListener((e) => {
      setProgress({ step: e.step, total: e.totalSteps });
      if (e.backend) setActiveBackend(e.backend);
    });
    return () => sub.remove();
  }, []);

  // ─── Generate handler ───────────────────────────────────────────
  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) {
      themedAlert('Empty prompt', 'Please enter something to generate.');
      return;
    }
    if (loadState !== 'ready') return;
    if (isGenerating) return;

    setIsGenerating(true);
    setProgress({ step: 0, total: steps });
    setResult(null);
    setLastPrompt(prompt.trim());
    setGenElapsed(0);
    genCancelled.current = false;
    genStartRef.current = Date.now();

    // Update elapsed time every second
    if (genTimerRef.current) clearInterval(genTimerRef.current);
    genTimerRef.current = setInterval(() => {
      setGenElapsed(Math.floor((Date.now() - genStartRef.current) / 1000));
    }, 1000);

    console.log(`[ImageGen] Generating: "${prompt.trim().substring(0, 60)}" ${imageSize}x${imageSize} steps=${steps} cfg=${cfgScale}`);

    try {
      const base64 = await ImageGenService.generateImage({
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        width: imageSize,
        height: imageSize,
        steps,
        cfgScale,
      });
      if (genCancelled.current) return;
      const totalSec = Math.round((Date.now() - genStartRef.current) / 1000);
      console.log(`[ImageGen] Generation complete! ${totalSec}s, Base64 length: ${base64?.length ?? 0}`);
      setResult(base64);
      setProgress(null);
      setLastGenTime(totalSec);

      // Save to chat history so image gen sessions appear in the drawer
      try {
        const imageUri = await ImageGenService.saveGeneratedImage(base64);
        addChatMessage({
          id: `img-user-${Date.now()}`,
          sender: 'User',
          message: prompt.trim(),
        });
        addChatMessage({
          id: `img-model-${Date.now()}`,
          sender: 'Model',
          message: `Generated in ${totalSec}s with ${model.name}`,
          imageUri,
        });
      } catch (histErr) {
        if (__DEV__) console.warn('[ImageGen] Failed to save to history:', histErr);
      }
    } catch (err: any) {
      const msg = err?.message ?? 'Unknown error';
      if (isContentBlocked(err)) {
        console.log(`[ImageGen] Blocked by content filter (${err.category})`);
        if (!genCancelled.current) themedAlert('Not allowed', msg);
        return;
      }
      console.error('[ImageGen] GENERATION FAILED:', msg);
      if (!genCancelled.current) {
        themedAlert('Generation failed', msg);
      }
    } finally {
      if (genTimerRef.current) {
        clearInterval(genTimerRef.current);
        genTimerRef.current = null;
      }
      setIsGenerating(false);
    }
  }, [prompt, negativePrompt, imageSize, steps, cfgScale, loadState, isGenerating, addChatMessage, model.name]);

  const handleCancel = useCallback(async () => {
    console.log('[ImageGen] User cancelled generation');
    genCancelled.current = true;
    await ImageGenService.cancelGeneration();
    setIsGenerating(false);
    setProgress(null);
  }, []);

  const handleShare = useCallback(async () => {
    if (!result) return;
    try {
      const tmpPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/microgpt-${Date.now()}.png`;
      await ReactNativeBlobUtil.fs.writeFile(tmpPath, result, 'base64');
      // On Android, share the image file via content URI (not the prompt text)
      if (Platform.OS === 'android') {
        await ReactNativeBlobUtil.android.actionViewIntent(
          tmpPath,
          'image/png',
        );
      } else {
        await Share.share({ url: tmpPath });
      }
    } catch (err: any) {
      themedAlert('Share failed', err?.message ?? 'Could not share image.');
    }
  }, [result]);

  const handleSave = useCallback(async () => {
    if (!result) return;
    try {
      const dir = getModelsDir();
      await ReactNativeBlobUtil.fs.mkdir(dir).catch(() => {});
      const savePath = `${dir}/generated-${Date.now()}.png`;
      await ReactNativeBlobUtil.fs.writeFile(savePath, result, 'base64');
      if (Platform.OS === 'android') {
        // Notify the media scanner so the image appears in the gallery.
        await ReactNativeBlobUtil.fs.scanFile([{ path: savePath, mime: 'image/png' }]);
        themedAlert('Saved', 'Image saved to gallery and Downloads/MicroGPT/');
      } else {
        // iOS has no public gallery dir; the file lives in the app's
        // Documents. Offer the share sheet to push it into Photos.
        themedAlert('Saved', 'Image saved. Use Share to add it to Photos.');
      }
    } catch (err: any) {
      themedAlert('Save failed', err?.message ?? 'Could not save image.');
    }
  }, [result]);

  const handleReport = useCallback(() => {
    promptReport(
      { contentType: 'image', modelName: model.name, prompt: lastPrompt },
      () => setResult(null),
    );
  }, [model.name, lastPrompt]);

  // ─── Render helpers ─────────────────────────────────────────────
  const renderLoadingState = () => {
    const isMnn = model.name.includes('-MNN') || model.name.includes('-NPU');
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <ActivityIndicator size="large" color={textColor} />
        <Text style={{ color: subTextColor, marginTop: 16, fontSize: 14 }}>
          Loading image model...
        </Text>
        <Text style={{ color: subTextColor, marginTop: 4, fontSize: 12 }}>
          {isMnn ? 'Preparing GPU/NPU engine' : 'Starting CPU engine'}
        </Text>
        {isMnn && (
          <View style={{
            marginTop: 8,
            backgroundColor: model.name.includes('-NPU') ? '#3E1F5E' : '#1E3A5F',
            paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
          }}>
            <Text style={{
              fontSize: 11, fontWeight: '700',
              color: model.name.includes('-NPU') ? '#C084FC' : '#60A5FA',
            }}>
              {model.name.includes('-NPU') ? 'NPU (Qualcomm Hexagon)' : 'GPU (Adreno OpenCL)'}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderErrorState = () => (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <Ionicons name="alert-circle-outline" size={48} color="#EF4444" />
      <Text
        style={{
          color: textColor,
          marginTop: 16,
          fontSize: 16,
          fontWeight: '600',
          textAlign: 'center',
        }}
      >
        Could not load model
      </Text>
      <Text
        selectable
        style={{
          color: subTextColor,
          marginTop: 12,
          fontSize: 13,
          textAlign: 'center',
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        }}
      >
        {loadError}
      </Text>
      <Text
        style={{
          color: subTextColor,
          marginTop: 16,
          fontSize: 11,
          textAlign: 'center',
          opacity: 0.7,
        }}
      >
        Long-press the message above to copy.
      </Text>
    </ScrollView>
  );

  const renderEmptyState = () => {
    const isMnn = model.name.includes('-MNN');
    const isNpu = model.name.includes('-NPU');
    const isCpu = !isMnn && !isNpu;
    const engineLabel = isNpu ? 'NPU (Hexagon)' : isMnn ? 'GPU (OpenCL)' : 'CPU';
    const engineColor = isNpu ? '#C084FC' : isMnn ? '#60A5FA' : subTextColor;
    const engineBg = isNpu ? '#3E1F5E' : isMnn ? '#1E3A5F' : cardBg;

    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: cardBg,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <Ionicons name="image-outline" size={32} color={subTextColor} />
        </View>
        <Text style={{ color: textColor, fontSize: 16, fontWeight: '600' }}>
          Ready to generate
        </Text>
        <View style={{
          marginTop: 8,
          backgroundColor: engineBg,
          paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
        }}>
          <Text style={{ fontSize: 11, fontWeight: '700', color: engineColor }}>
            {engineLabel}
          </Text>
        </View>
        <Text
          style={{
            color: subTextColor,
            marginTop: 10,
            fontSize: 13,
            textAlign: 'center',
            maxWidth: 280,
          }}
        >
          {isCpu
            ? 'CPU mode — supports all model formats. ~3 min per image.'
            : isNpu
              ? 'Snapdragon NPU — fastest. ~5-15s per image.'
              : 'Adreno GPU — fast. ~20-30s per image.'}
        </Text>
      </View>
    );
  };

  const renderGeneratingState = () => {
    const pct = progress ? Math.round((progress.step / Math.max(1, progress.total)) * 100) : 0;
    const mins = Math.floor(genElapsed / 60);
    const secs = genElapsed % 60;
    const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <ActivityIndicator size="large" color={textColor} />
        <Text style={{ color: textColor, marginTop: 16, fontSize: 16, fontWeight: '600' }}>
          Generating...
        </Text>
        {activeBackend ? (
          <View style={{
            marginTop: 8,
            backgroundColor: activeBackend.includes('GPU') ? '#1E3A5F' :
                            activeBackend.includes('NPU') ? '#3E1F5E' : cardBg,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 12,
          }}>
            <Text style={{
              fontSize: 11,
              fontWeight: '700',
              color: activeBackend.includes('GPU') ? '#60A5FA' :
                    activeBackend.includes('NPU') ? '#C084FC' : subTextColor,
            }}>
              {activeBackend}
            </Text>
          </View>
        ) : null}
        {progress && (
          <>
            <View
              style={{
                marginTop: 12,
                width: 260,
                height: 6,
                borderRadius: 3,
                backgroundColor: cardBg,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${Math.max(pct, 2)}%`,
                  height: '100%',
                  backgroundColor: accentBg,
                }}
              />
            </View>
            <Text style={{ color: subTextColor, marginTop: 8, fontSize: 13 }}>
              Step {progress.step} / {progress.total}
            </Text>
          </>
        )}
        <Text style={{ color: subTextColor, marginTop: 6, fontSize: 12, opacity: 0.7 }}>
          {elapsed}
        </Text>
        <Text
          style={{
            color: subTextColor,
            marginTop: 16,
            fontSize: 11,
            textAlign: 'center',
            opacity: 0.5,
            maxWidth: 260,
          }}
        >
          {activeBackend.includes('GPU')
            ? 'GPU accelerated via OpenCL. First run compiles kernels (~30s), cached after.'
            : activeBackend.includes('NPU')
              ? 'NPU accelerated via Qualcomm Hexagon. Fastest on-device inference.'
              : 'CPU inference. Use MNN or NPU models for faster generation.'}
        </Text>
      </View>
    );
  };

  const renderResult = () => (
    <ScrollView
      contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
      showsVerticalScrollIndicator={false}
    >
      <Pressable
        onLongPress={handleSave}
        delayLongPress={400}
        style={{
          aspectRatio: 1,
          borderRadius: 16,
          overflow: 'hidden',
          backgroundColor: cardBg,
          marginBottom: 12,
        }}
      >
        <Image
          source={{ uri: `data:image/png;base64,${result}` }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="cover"
        />
      </Pressable>
      {/* Generation metadata — like the competitor shows */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {lastGenTime > 0 && (
          <View style={{ backgroundColor: cardBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
            <Text style={{ fontSize: 11, color: subTextColor, fontWeight: '600' }}>
              {lastGenTime}s
            </Text>
          </View>
        )}
        {activeBackend ? (
          <View style={{
            backgroundColor: activeBackend.includes('GPU') ? '#1E3A5F' :
                            activeBackend.includes('NPU') ? '#3E1F5E' : cardBg,
            paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
          }}>
            <Text style={{
              fontSize: 11, fontWeight: '600',
              color: activeBackend.includes('GPU') ? '#60A5FA' :
                    activeBackend.includes('NPU') ? '#C084FC' : subTextColor,
            }}>
              {activeBackend}
            </Text>
          </View>
        ) : null}
        <View style={{ backgroundColor: cardBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
          <Text style={{ fontSize: 11, color: subTextColor, fontWeight: '600' }}>
            {imageSize}x{imageSize}
          </Text>
        </View>
        <View style={{ backgroundColor: cardBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
          <Text style={{ fontSize: 11, color: subTextColor, fontWeight: '600' }}>
            {steps} steps
          </Text>
        </View>
      </View>
      <Text style={{ color: subTextColor, fontSize: 12, marginBottom: 12 }} numberOfLines={3}>
        {lastPrompt}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity
          onPress={handleSave}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: cardBg,
            borderWidth: 1,
            borderColor,
          }}
        >
          <Ionicons name="download-outline" size={18} color={textColor} />
          <Text style={{ color: textColor, marginLeft: 6, fontWeight: '600' }}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleShare}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: cardBg,
            borderWidth: 1,
            borderColor,
          }}
        >
          <Ionicons name="share-outline" size={18} color={textColor} />
          <Text style={{ color: textColor, marginLeft: 6, fontWeight: '600' }}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleReport}
          accessibilityLabel="Report image"
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: cardBg,
            borderWidth: 1,
            borderColor,
          }}
        >
          <Ionicons name="flag-outline" size={18} color={textColor} />
          <Text style={{ color: textColor, marginLeft: 6, fontWeight: '600' }}>Report</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  // ─── Body ───────────────────────────────────────────────────────
  let body: React.ReactNode;
  if (loadState === 'loading') body = renderLoadingState();
  else if (loadState === 'error') body = renderErrorState();
  else if (isGenerating) body = renderGeneratingState();
  else if (result) body = renderResult();
  else body = renderEmptyState();

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: bgColor }}
    >
      <View style={{ flex: 1 }}>{body}</View>

      {/* Advanced settings drawer (collapsed by default) */}
      {showAdvanced && loadState === 'ready' && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 4,
            backgroundColor: bgColor,
            borderTopWidth: 1,
            borderTopColor: borderColor,
          }}
        >
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
            {/* Steps */}
            <View style={{ flex: 1 }}>
              <Text style={{ color: subTextColor, fontSize: 11, marginBottom: 4, fontWeight: '600' }}>
                STEPS
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: cardBg, borderRadius: 8, paddingHorizontal: 4 }}>
                <TouchableOpacity
                  onPress={() => setSteps((s) => Math.max(1, s - 1))}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="remove" size={16} color={textColor} />
                </TouchableOpacity>
                <Text style={{ color: textColor, flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600' }}>
                  {steps}
                </Text>
                <TouchableOpacity
                  onPress={() => setSteps((s) => Math.min(50, s + 1))}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="add" size={16} color={textColor} />
                </TouchableOpacity>
              </View>
            </View>
            {/* CFG */}
            <View style={{ flex: 1 }}>
              <Text style={{ color: subTextColor, fontSize: 11, marginBottom: 4, fontWeight: '600' }}>
                CFG
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: cardBg, borderRadius: 8, paddingHorizontal: 4 }}>
                <TouchableOpacity
                  onPress={() => setCfgScale((c) => Math.max(1, Math.round((c - 0.5) * 10) / 10))}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="remove" size={16} color={textColor} />
                </TouchableOpacity>
                <Text style={{ color: textColor, flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600' }}>
                  {cfgScale.toFixed(1)}
                </Text>
                <TouchableOpacity
                  onPress={() => setCfgScale((c) => Math.min(15, Math.round((c + 0.5) * 10) / 10))}
                  style={{ padding: 8 }}
                >
                  <Ionicons name="add" size={16} color={textColor} />
                </TouchableOpacity>
              </View>
            </View>
            {/* Size */}
            <View style={{ flex: 1 }}>
              <Text style={{ color: subTextColor, fontSize: 11, marginBottom: 4, fontWeight: '600' }}>
                SIZE
              </Text>
              <TouchableOpacity
                onPress={() => {
                  if (isNpu) return; // NPU graphs are baked at 512x512
                  // Cycle: 256 → 384 → 512 → 256
                  setImageSize((s) => (s >= 512 ? 256 : s >= 384 ? 512 : 384));
                }}
                disabled={isNpu}
                style={{ backgroundColor: cardBg, borderRadius: 8, paddingVertical: 10, alignItems: 'center', opacity: isNpu ? 0.6 : 1 }}
              >
                <Text style={{ color: textColor, fontSize: 14, fontWeight: '600' }}>
                  {imageSize}
                </Text>
              </TouchableOpacity>
              {isNpu ? (
                <Text style={{ color: subTextColor, fontSize: 9, textAlign: 'center', marginTop: 2 }}>
                  Fixed at 512
                </Text>
              ) : imageSize >= 512 ? (
                <Text style={{ color: '#EF4444', fontSize: 9, textAlign: 'center', marginTop: 2 }}>
                  needs 12GB+ RAM
                </Text>
              ) : null}
            </View>
          </View>
        </View>
      )}

      {/* Negative prompt input (collapsed by default) */}
      {showNegative && loadState === 'ready' && (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 4,
            backgroundColor: bgColor,
          }}
        >
          <TextInput
            value={negativePrompt}
            onChangeText={setNegativePrompt}
            placeholder="Negative prompt — things to avoid (e.g. blurry, low quality)"
            placeholderTextColor={placeholderColor}
            multiline
            style={{
              backgroundColor: inputBg,
              borderRadius: 16,
              paddingHorizontal: 16,
              paddingVertical: 10,
              color: textColor,
              fontSize: 14,
              maxHeight: 80,
            }}
            keyboardAppearance={isDark ? 'dark' : 'light'}
          />
        </View>
      )}

      {/* Main prompt bar */}
      <View style={{ backgroundColor: bgColor }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            backgroundColor: inputBg,
            borderRadius: 30,
            marginHorizontal: 16,
            marginVertical: 12,
            paddingLeft: 16,
            paddingRight: 6,
            paddingVertical: 6,
            minHeight: 48,
          }}
        >
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="a cute cat sitting on a windowsill, soft lighting"
            placeholderTextColor={placeholderColor}
            multiline
            editable={loadState === 'ready' && !isGenerating}
            style={{
              flex: 1,
              color: textColor,
              fontSize: 16,
              paddingVertical: 8,
              maxHeight: 120,
            }}
            keyboardAppearance={isDark ? 'dark' : 'light'}
          />

          {/* Advanced toggle */}
          <TouchableOpacity
            onPress={() => setShowAdvanced((v) => !v)}
            style={{
              padding: 8,
              borderRadius: 999,
              backgroundColor: showAdvanced ? accentBg : 'transparent',
              marginRight: 2,
            }}
          >
            <Ionicons
              name="options-outline"
              size={18}
              color={showAdvanced ? accentFg : subTextColor}
            />
          </TouchableOpacity>

          {/* Negative prompt toggle */}
          <TouchableOpacity
            onPress={() => setShowNegative((v) => !v)}
            style={{
              padding: 8,
              borderRadius: 999,
              backgroundColor: showNegative ? accentBg : 'transparent',
              marginRight: 4,
            }}
          >
            <Ionicons
              name="remove-circle-outline"
              size={18}
              color={showNegative ? accentFg : subTextColor}
            />
          </TouchableOpacity>

          {/* Generate / Stop button */}
          {(() => {
            const canSubmit =
              loadState === 'ready' && (isGenerating || prompt.trim().length > 0);
            return (
              <TouchableOpacity
                onPress={isGenerating ? handleCancel : handleGenerate}
                disabled={!canSubmit}
                style={{
                  padding: 10,
                  borderRadius: 999,
                  backgroundColor: canSubmit ? accentBg : '#A0A0A0',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons
                  name={isGenerating ? 'stop' : 'sparkles'}
                  size={20}
                  color={canSubmit ? accentFg : '#666666'}
                />
              </TouchableOpacity>
            );
          })()}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};

export default ImageGenerationView;
