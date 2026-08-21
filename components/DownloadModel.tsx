// app/(root)/components/DownloadModel.tsx
import React, { useMemo, useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  useColorScheme,
  Platform,
} from 'react-native';
import { themedAlert } from '@/components/ThemedAlert';
import Ionicons from '@expo/vector-icons/Ionicons';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as DocumentPicker from 'expo-document-picker';
import { useStore, Model, isImageGenModel, getModelFileName, formatBytes, formatEta, getRecommendedModelName } from '@/store';
import type { DownloadPhase } from '@/store';
import { repoFromHfUrl } from '@/lib/hf-url';

/**
 * Per-row progress view. Lives in its OWN component so it can subscribe to
 * just this model's progress/stats/phase — that way a 500 ms tick on model
 * A doesn't force every other row (or the modal chrome) to re-render, which
 * was the root cause of the "hard to close the modal while N models are
 * downloading" lag.
 */
const DownloadProgressView = React.memo(function DownloadProgressView({
  modelName,
}: {
  modelName: string;
}) {
  const colorScheme = useColorScheme();
  const raw = useStore((s) => s.downloadProgress?.[modelName] ?? 0);
  const phase = useStore((s) => s.downloadPhase?.[modelName]) as DownloadPhase | undefined;
  const stats = useStore((s) => s.downloadStats?.[modelName]);
  const indeterminate = raw < 0;
  const isActiveTransfer = !phase || phase === 'downloading' || phase === 'downloading_projector';
  const isPostDownload = !isActiveTransfer;
  const fraction = indeterminate ? 0 : Math.max(0, Math.min(1, raw));
  const displayPct = isPostDownload
    ? 100
    : Math.min(99, Math.round(fraction * 100));
  const barBg = colorScheme === 'dark' ? '#2A2A2A' : '#E6E6E6';
  const barFill = colorScheme === 'dark' ? '#3B82F6' : '#2563EB';
  const subColor = colorScheme === 'dark' ? '#9BA1A6' : '#666666';

  let statusText = '';
  if (indeterminate && phase === 'downloading_projector') {
    statusText = 'Vision projector \u00B7 starting\u2026';
  } else if (indeterminate) {
    statusText = 'Downloading in background\u2026';
  } else if (phase === 'verifying') {
    statusText = 'Verifying download\u2026';
  } else if (phase === 'extracting') {
    statusText = 'Extracting model files\u2026';
  } else if (phase === 'finalizing') {
    statusText = 'Finalizing\u2026';
  } else {
    const parts: string[] = [];
    if (phase === 'downloading_projector') parts.push('Vision projector');
    parts.push(`${displayPct}%`);
    if (stats?.bytesPerSec && stats.bytesPerSec > 0) {
      parts.push(`${formatBytes(stats.bytesPerSec)}/s`);
    }
    if (stats?.etaSeconds != null && stats.etaSeconds > 0) {
      parts.push(formatEta(stats.etaSeconds));
    }
    statusText = parts.join('  \u00B7  ');
  }

  const barWidth = indeterminate
    ? ('35%' as const)
    : isPostDownload
      ? ('100%' as const)
      : (`${displayPct}%` as `${number}%`);

  return (
    <View style={{ marginTop: 6 }}>
      <View
        style={{
          height: 4,
          backgroundColor: barBg,
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: '100%',
            width: barWidth,
            backgroundColor: barFill,
            opacity: indeterminate ? 0.55 : 1,
          }}
        />
      </View>
      <Text style={{ fontSize: 11, marginTop: 2, color: subColor }}>
        {statusText}
      </Text>
    </View>
  );
});

/** Convert "2.1 GB" => bytes, "1.7 GB" => bytes, etc. */
function parseFileSizeString(sizeString: string): number {
  const match = sizeString.match(/([\d\.]+)\s*(GB|MB|KB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'GB') return value * 1024 * 1024 * 1024;
  if (unit === 'MB') return value * 1024 * 1024;
  if (unit === 'KB') return value * 1024;
  return 0;
}

/**
 * Returns icon name based on model-to-memory ratio.
 * ratio < 0.4 -> null (safe)
 * ratio < 0.65 -> 'warning' (yellow)
 * ratio >= 0.65 -> 'close-circle' (red / likely crash)
 */
function getIconNameForRatio(
  ratio: number
): keyof typeof Ionicons.glyphMap | null {
  if (ratio < 0.4) return null;
  if (ratio < 0.65) return 'warning';
  return 'close-circle';
}

/** Returns icon color based on model-to-memory ratio. */
function getColorByRatio(ratio: number): string {
  if (ratio < 0.4) return 'transparent';
  if (ratio < 0.65) return '#CCAA00'; // yellow
  return '#CC0000'; // red
}

/** Helper to separate a set of Models into [downloaded, notDownloaded], preserving order. */
function splitDownloaded(models: Model[], downloadedList: string[]) {
  const downloaded: Model[] = [];
  const notDownloaded: Model[] = [];
  for (const m of models) {
    // Check both the full filename (e.g. "SD-1.5-Q4.gguf") and
    // bare name (e.g. "AbsoluteReality" for MNN directories that
    // were unzipped and stored as folder names without extensions).
    const byFile = downloadedList.includes(getModelFileName(m));
    const byName = downloadedList.includes(m.name);
    // Also check if the zip's internal folder name matches
    // (e.g. "AbsoluteReality-MNN" downloads "AbsoluteReality.zip"
    // which unzips to "AbsoluteReality/" folder)
    const baseName = m.name.replace(/-(MNN|NPU)$/, '');
    const byBaseName = downloadedList.includes(baseName);
    if (byFile || byName || byBaseName) downloaded.push(m);
    else notDownloaded.push(m);
  }
  return { downloaded, notDownloaded };
}

/**
 * We gather builtIn, huggingface, local in one array, but "section by section" in a single FlatList.
 * Data items can be either {type: 'header', title: string} or {type: 'model', model: Model}.
 */
type HeaderItem = {
  type: 'header';
  title: string;
};

type ModelItem = {
  type: 'model';
  model: Model;
};

type ListItem = HeaderItem | ModelItem;

type Props = {
  visible: boolean;
  onClose: () => void;
  onUseModel?: (modelName: string) => void;
  onEjectModel?: (modelName: string) => void;
  onDeleteModel?: (modelName: string) => Promise<void>;
};

const DownloadModel: React.FC<Props> = ({
  visible,
  onClose,
  onUseModel,
  onEjectModel,
  onDeleteModel,
}) => {
  const colorScheme = useColorScheme();
  // Per-field selectors — avoids subscribing to high-frequency fields
  // (downloadProgress/downloadStats/downloadPhase) at this level. Those
  // now live inside DownloadProgressView, which subscribes per-model.
  // Keeping them here would force the whole modal to re-render every
  // 500 ms per active download, which made closing the modal feel stuck
  // when 2+ models were downloading in parallel.
  const models = useStore((s) => s.models);
  const downloadedModels = useStore((s) => s.downloadedModels);
  const activeDownloads = useStore((s) => s.activeDownloads);
  const selectedModel = useStore((s) => s.selectedModel);
  const totalDeviceMemory = useStore((s) => s.totalDeviceMemory);
  const downloadModel = useStore((s) => s.downloadModel);
  const deleteModel = useStore((s) => s.deleteModel);
  const cancelDownload = useStore((s) => s.cancelDownload);
  const setDidUserCloseDownloadModal = useStore((s) => s.setDidUserCloseDownloadModal);
  const addLocalModel = useStore((s) => s.addLocalModel);

  // Hardware-aware recommendation — one headline text model per RAM
  // tier. Surfaced as a green RECOMMENDED badge on the matching row.
  // Null when the probe hasn't run (hide the badge rather than guess).
  const recommendedModelName = useMemo(
    () => getRecommendedModelName(totalDeviceMemory),
    [totalDeviceMemory],
  );

  // Search box. Case-insensitive substring match on name + description.
  // Empty query means no filtering (show everything).
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const matchesSearch = (m: Model): boolean => {
    if (!normalizedSearch) return true;
    return (
      m.name.toLowerCase().includes(normalizedSearch) ||
      (m.description ?? '').toLowerCase().includes(normalizedSearch)
    );
  };

  // Probe device QNN/NPU support once. NPU models are useless on
  // non-Snapdragon devices and we should warn users before they waste
  // 1 GB downloading one.
  // Default to false — NPU models stay hidden until the probe confirms
  // support. The old default of true caused NPU models to flash on all
  // devices during the first render before the async probe completed.
  const [npuSupported, setNpuSupported] = useState<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== 'android') { setNpuSupported(false); return; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const SD = require('expo-stable-diffusion');
      const diag: string = SD?.hello?.() ?? '';
      const match = diag.match(/qnn=(\S+)/);
      setNpuSupported(match ? match[1] !== 'unsupported' : false);
    } catch { setNpuSupported(false); }
  }, []);

  // Single color used for icons in general (dark vs light)
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  // Button background and text color
  const buttonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const buttonTextColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  /**
   * Step 1: build arrays for builtIn, HF, local, preserving store order.
   * Then for each category: put downloaded items first, then not downloaded items.
   *
   * Built-in models are further split into text/vision (handled by llama.rn)
   * and image-generation (handled by expo-stable-diffusion) so they get
   * their own sections in the list — different engines, different UI flow,
   * different user expectations.
   */
  const builtInTextModels = useMemo(() => {
    return models.filter((m) => {
      if (m.source !== 'builtIn' || isImageGenModel(m)) return false;
      // Hide NPU models on unsupported devices (unless already downloaded)
      if (!npuSupported && m.name.endsWith('-NPU')) {
        const modelFile = getModelFileName(m);
        const baseName = m.name.replace(/-(MNN|NPU)$/, '');
        const isDownloaded = downloadedModels.includes(modelFile)
          || downloadedModels.includes(m.name)
          || downloadedModels.includes(baseName);
        if (!isDownloaded) return false;
      }
      return true;
    });
  }, [models, npuSupported, downloadedModels]);

  const builtInImageGenModels = useMemo(() => {
    return models.filter((m) => {
      if (m.source !== 'builtIn' || !isImageGenModel(m)) return false;
      // Hide NPU models on unsupported devices (unless already downloaded)
      if (!npuSupported && m.name.endsWith('-NPU')) {
        const modelFile = getModelFileName(m);
        const baseName = m.name.replace(/-(MNN|NPU)$/, '');
        const isDownloaded = downloadedModels.includes(modelFile)
          || downloadedModels.includes(m.name)
          || downloadedModels.includes(baseName);
        if (!isDownloaded) return false;
      }
      return true;
    });
  }, [models, npuSupported, downloadedModels]);

  const hfTextModels = useMemo(() => {
    return models.filter(
      (m) => m.source === 'huggingface' && !isImageGenModel(m),
    );
  }, [models]);

  const hfImageGenModels = useMemo(() => {
    return models.filter(
      (m) => m.source === 'huggingface' && isImageGenModel(m),
    );
  }, [models]);

  const localTextModels = useMemo(() => {
    return models.filter(
      (m) => m.source === 'local' && !isImageGenModel(m),
    );
  }, [models]);

  const localImageGenModels = useMemo(() => {
    return models.filter(
      (m) => m.source === 'local' && isImageGenModel(m),
    );
  }, [models]);

  // We preserve the original order of each group, then do downloaded first, notDownloaded second.
  // Applies the search filter if the user has typed a query — empty
  // sections are dropped at the call site below.
  const makeOrderedArray = (group: Model[]) => {
    const groupNames = group.map((m) => m.name);
    // preserve store order
    let sortedGroup = models.filter((m) => groupNames.includes(m.name));
    if (normalizedSearch) sortedGroup = sortedGroup.filter(matchesSearch);
    const { downloaded, notDownloaded } = splitDownloaded(
      sortedGroup,
      downloadedModels
    );
    return [...downloaded, ...notDownloaded];
  };

  // Step 2: build a single data array with "header" items + "model" items
  const data: ListItem[] = [];

  // ============= BUILT-IN TEXT / VISION MODELS =============
  const builtInTextFinal = makeOrderedArray(builtInTextModels);
  if (builtInTextFinal.length > 0) {
    data.push({ type: 'header', title: 'Suggested Models' });
    for (const model of builtInTextFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= BUILT-IN IMAGE GENERATION MODELS =============
  const builtInImageGenFinal = makeOrderedArray(builtInImageGenModels);
  if (builtInImageGenFinal.length > 0) {
    data.push({ type: 'header', title: 'Image Generation Models' });
    for (const model of builtInImageGenFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= HF TEXT / VISION MODELS =============
  const hfTextFinal = makeOrderedArray(hfTextModels);
  if (hfTextFinal.length > 0) {
    data.push({ type: 'header', title: 'Hugging Face Models' });
    for (const model of hfTextFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= HF IMAGE GENERATION MODELS =============
  const hfImageGenFinal = makeOrderedArray(hfImageGenModels);
  if (hfImageGenFinal.length > 0) {
    data.push({ type: 'header', title: 'Hugging Face Image Generation' });
    for (const model of hfImageGenFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= LOCAL TEXT / VISION MODELS =============
  const localTextFinal = makeOrderedArray(localTextModels);
  if (localTextFinal.length > 0) {
    data.push({ type: 'header', title: 'Local Models' });
    for (const model of localTextFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= LOCAL IMAGE GENERATION MODELS =============
  const localImageGenFinal = makeOrderedArray(localImageGenModels);
  if (localImageGenFinal.length > 0) {
    data.push({ type: 'header', title: 'Local Image Generation' });
    for (const model of localImageGenFinal) {
      data.push({ type: 'model', model });
    }
  }

  /** Called when user closes the modal. */
  const handleClose = () => {
    setDidUserCloseDownloadModal(true);
    onClose();
  };

  /**
   * Memory-based checks/warnings on download
   */
  const handleDownload = async (model: Model) => {
    const bytes = parseFileSizeString(model.size || '');
    if (bytes <= 0) {
      themedAlert('Size Unknown', 'Model size not found. Proceed anyway?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'OK', onPress: () => doDownload(model) },
      ]);
      return;
    }
    const ratio = totalDeviceMemory > 0 ? bytes / totalDeviceMemory : 0;
    if (ratio >= 0.85) {
      themedAlert(
        'Very Likely to Crash',
        'This model exceeds your estimated available memory. It will almost certainly crash. Download anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download Anyway',
            style: 'destructive',
            onPress: () => doDownload(model),
          },
        ]
      );
    } else if (ratio >= 0.65) {
      themedAlert(
        'High Risk of Crash',
        'This model is large relative to your available memory. It may crash when loading. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download',
            style: 'destructive',
            onPress: () => doDownload(model),
          },
        ]
      );
    } else if (ratio >= 0.4) {
      themedAlert(
        'Moderate Memory Usage',
        'This model will use a significant portion of your available memory. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', onPress: () => doDownload(model) },
        ]
      );
    } else {
      await doDownload(model);
    }
  };

  /** Actually calls store.downloadModel */
  const doDownload = async (model: Model) => {
    await downloadModel(model);
  };

  const handleCancel = (modelName: string) => {
    cancelDownload(modelName);
  };

  const handleDelete = async (modelName: string) => {
    // Unload native context before deleting files from disk
    if (onDeleteModel) await onDeleteModel(modelName);
    await deleteModel(modelName);
  };

  const handleUseModelPress = (modelName: string) => {
    onUseModel?.(modelName);
    onClose();
  };

  const handleEjectPress = (modelName: string) => {
    onEjectModel?.(modelName);
    onClose();
  };

  // Called when user taps the yellow/red icon
  const handleIconTap = () => {
    themedAlert(
      'Warning',
      'Model size is close to or exceeds your device memory. This may cause unexpected behaviour.'
    );
  };

  // Ask the user whether the file they're about to pick is a chat
  // model or an image-generation model, then run the picker with
  // extension + classification appropriate for that choice.
  //
  // Engine selection (NPU vs GPU vs CPU) is handled at LOAD time by
  // the native loader: for MNN/QNN zips it searches the extracted
  // directory for `unet.bin` (→ QNN) or `unet.mnn` (→ MNN) and falls
  // back GPU→CPU automatically if the preferred backend fails
  // (see ExpoStableDiffusionModule.kt loadModel). Here we only need
  // to tag the file as text vs imageGen so it lands in the right
  // section of the UI and uses the right inference engine.
  const handlePickLocalModel = async () => {
    if (Platform.OS === 'web') {
      themedAlert('Not supported', 'Local file picking is not supported on Web.');
      return;
    }

    themedAlert(
      'Load a Local Model',
      'What kind of model are you loading?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Text / Chat',
          onPress: () => pickLocalFile('text'),
        },
        {
          text: 'Image Generation',
          onPress: () => pickLocalFile('imageGen'),
        },
      ],
    );
  };

  const pickLocalFile = async (hintedType: 'text' | 'imageGen') => {
    try {
      // Extension allow-list per kind:
      //   text      → .gguf only
      //   imageGen  → .gguf (sd.cpp), .safetensors, .ckpt, .zip (MNN/QNN)
      const allowedExts = hintedType === 'text'
        ? ['.gguf']
        : ['.gguf', '.safetensors', '.ckpt', '.zip'];

      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*', // Android DocumentPicker doesn't filter by extension reliably
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const doc = (result as any).assets?.[0] ?? result;
      if (!doc.uri) {
        themedAlert('Error', 'No URI returned from the file picker.');
        return;
      }
      const fileName: string = doc.name ?? doc.uri.split('/').pop() ?? 'untitled.gguf';
      const lower = fileName.toLowerCase();
      const matchedExt = allowedExts.find((e) => lower.endsWith(e));
      if (!matchedExt) {
        themedAlert(
          'Unsupported File',
          hintedType === 'text'
            ? 'Text models must be a .gguf file.'
            : 'Image models must be a .gguf, .safetensors, .ckpt, or .zip (MNN/QNN) file.',
        );
        return;
      }

      // If the user said "image" and picked a .zip whose filename
      // suggests QNN but the device has no NPU support, warn before
      // copying the (usually ~1 GB) archive into storage for nothing.
      if (hintedType === 'imageGen' && matchedExt === '.zip' &&
          !npuSupported && lower.includes('qnn')) {
        const proceed = await new Promise<boolean>((resolve) => {
          themedAlert(
            'NPU Not Supported',
            `This looks like a QNN (NPU) model, but your device doesn't have Qualcomm NPU support. It will almost certainly fail to load. Copy anyway?`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Copy Anyway', style: 'destructive', onPress: () => resolve(true) },
            ],
          );
        });
        if (!proceed) return;
      }

      await addLocalModel(doc.uri, fileName, hintedType);
      themedAlert(
        'Success',
        `"${fileName}" added.${
          matchedExt === '.zip' ? ' The bundle has been extracted — you can now load it from the list.' : ''
        }`,
      );
    } catch (error: any) {
      if (__DEV__) console.warn('pickLocalFile error:', error);
      themedAlert('Error', `Failed to pick file: ${error?.message ?? 'unknown'}`);
    }
  };

  /** Renders a header row */
  const renderHeaderItem = (item: HeaderItem) => {
    return (
      <View style={{ marginTop: 12, marginBottom: 4 }}>
        <Text
          style={{
            fontSize: 18,
            fontWeight: '600',
            color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
          }}
        >
          {item.title}
        </Text>
      </View>
    );
  };

  /** Renders a single model row */
  const renderModelItem = (model: Model) => {
    const bytes = parseFileSizeString(model.size || '');
    const ratio = totalDeviceMemory > 0 ? bytes / totalDeviceMemory : 0;

    // Only show icon if ratio >= 0.5
    const iconName = getIconNameForRatio(ratio);
    const ratioIconColor = getColorByRatio(ratio);

    const modelFile = getModelFileName(model);
    const baseName = model.name.replace(/-(MNN|NPU)$/, '');
    const isDownloaded = downloadedModels.includes(modelFile)
      || downloadedModels.includes(model.name)
      || downloadedModels.includes(baseName);
    const isDownloadingThisOne =
      activeDownloads instanceof Set ? activeDownloads.has(model.name) : false;
    const { selectedTextModel, selectedImageGenModel, comboModeEnabled } = useStore.getState();
    const isSelectedAsText = selectedTextModel?.name === model.name;
    const isSelectedAsImage = selectedImageGenModel?.name === model.name;
    const isSelected = selectedModel?.name === model.name || isSelectedAsText || isSelectedAsImage;

    return (
      <View className="border-b border-theme-light-border dark:border-theme-dark-border py-3">
        <View className="flex-row items-start justify-between">
          <View style={{ flex: 1, paddingRight: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              {iconName && (
                <TouchableOpacity
                  onPress={handleIconTap}
                  style={{ marginRight: 8 }}
                >
                  <Ionicons name={iconName} size={16} color={ratioIconColor} />
                </TouchableOpacity>
              )}
              <Text
                className="text-base font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary"
                style={{ flex: 1 }}
              >
                {model.name}
              </Text>
            </View>
            {(() => {
              const isRecommended =
                !!recommendedModelName && model.name === recommendedModelName;
              const showBadgeRow =
                !!model.mmProjUrl ||
                isImageGenModel(model) ||
                isRecommended ||
                (!npuSupported && model.name.endsWith('-NPU'));
              if (!showBadgeRow) return null;
              return (
                <View style={{ flexDirection: 'row', marginTop: 4, flexWrap: 'wrap' }}>
                  {isRecommended && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#14532D' : '#DCFCE7',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginRight: 6,
                      marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#86EFAC' : '#166534',
                      }}>RECOMMENDED</Text>
                    </View>
                  )}
                  {model.mmProjUrl && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#1E293B' : '#EFF6FF',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginRight: 6,
                      marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#93C5FD' : '#2563EB',
                      }}>VISION</Text>
                    </View>
                  )}
                  {/* Image-gen sub-types: NPU > GPU(MNN) > generic IMAGE GEN.
                      Mirrors what the HF download UI shows so users see
                      consistent labelling before AND after download. */}
                  {model.name.endsWith('-NPU') && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#3E1F5E' : '#F5E8FF',
                      paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                      marginRight: 6, marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10, fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#C084FC' : '#9333EA',
                      }}>NPU (QNN)</Text>
                    </View>
                  )}
                  {model.name.endsWith('-MNN') && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#1E3A5F' : '#EFF6FF',
                      paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                      marginRight: 6, marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10, fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#60A5FA' : '#2563EB',
                      }}>GPU (MNN)</Text>
                    </View>
                  )}
                  {isImageGenModel(model) && !model.name.endsWith('-NPU') && !model.name.endsWith('-MNN') && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#3B1E4E' : '#F5E8FF',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginRight: 6,
                      marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#D8B4FE' : '#9333EA',
                      }}>IMAGE GEN (CPU)</Text>
                    </View>
                  )}
                  {/* TEXT LLM badge — anything that isn't image-gen and
                      doesn't have vision capability. Matches the HF UI's
                      gray TEXT LLM tag. */}
                  {!isImageGenModel(model) && !model.mmProjUrl && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#1F2937' : '#F3F4F6',
                      paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                      marginRight: 6, marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10, fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280',
                      }}>TEXT LLM</Text>
                    </View>
                  )}
                  {!npuSupported && model.name.endsWith('-NPU') && (
                    <View style={{
                      backgroundColor: colorScheme === 'dark' ? '#4A1E1E' : '#FEE2E2',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginBottom: 2,
                    }}>
                      <Text style={{
                        fontSize: 10,
                        fontWeight: 'bold',
                        color: colorScheme === 'dark' ? '#FCA5A5' : '#DC2626',
                      }}>SNAPDRAGON ONLY</Text>
                    </View>
                  )}
                </View>
              );
            })()}
            {/* HuggingFace `<owner>/<repo>` line — extracted from the
                model URL so it's available even on builtIn entries
                whose hardcoded description doesn't mention the repo.
                Skipped if the description already contains it (avoids
                duplicating "Chun121/Foo — Chun121/Foo …"). */}
            {(() => {
              const repo = repoFromHfUrl(model.url);
              if (!repo) return null;
              if (model.description?.toLowerCase().includes(repo.toLowerCase())) return null;
              return (
                <Text
                  className="text-xs text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1"
                  style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}
                >
                  {repo}
                </Text>
              );
            })()}
            {model.description?.length ? (
              <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1">
                {model.description}
              </Text>
            ) : null}
            {model.size ? (
              <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1">
                Size: {model.size}{model.mmProjSize ? ` + ${model.mmProjSize} (vision)` : ''}
              </Text>
            ) : null}
            {isDownloadingThisOne && (
              <DownloadProgressView modelName={model.name} />
            )}
            {/* Combo mode slot indicators */}
            {comboModeEnabled && isSelectedAsText && (
              <View style={{
                backgroundColor: colorScheme === 'dark' ? '#1E3A5F' : '#DBEAFE',
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginTop: 4, alignSelf: 'flex-start',
              }}>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: colorScheme === 'dark' ? '#93C5FD' : '#2563EB' }}>
                  TEXT MODEL LOADED
                </Text>
              </View>
            )}
            {comboModeEnabled && isSelectedAsImage && (
              <View style={{
                backgroundColor: colorScheme === 'dark' ? '#3B1E5F' : '#EDE9FE',
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginTop: 4, alignSelf: 'flex-start',
              }}>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: colorScheme === 'dark' ? '#C4B5FD' : '#7C3AED' }}>
                  IMAGE MODEL LOADED
                </Text>
              </View>
            )}
            {isDownloaded && !isSelected && (
              <TouchableOpacity
                onPress={() => handleUseModelPress(model.name)}
                className="mt-2 p-2 w-24 items-center rounded-full"
                style={{ backgroundColor: buttonBg }}
              >
                <Text
                  className="font-bold"
                  style={{ fontSize: 14, color: buttonTextColor }}
                >
                  Use Model
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <View className="flex-col items-end" style={{ width: 30 }}>
            {/* If selected + downloaded => show the eject icon */}
            {isDownloaded && isSelected && (
              <TouchableOpacity
                onPress={() => handleEjectPress(model.name)}
                style={{ marginBottom: 10 }}
              >
                <FontAwesome6 name="eject" size={20} color={iconColor} />
              </TouchableOpacity>
            )}

            {isDownloaded ? (
              // Show trash for downloaded
              <TouchableOpacity onPress={() => handleDelete(model.name)}>
                <Ionicons name="trash" size={20} color={iconColor} />
              </TouchableOpacity>
            ) : (
              <>
                {isDownloadingThisOne ? (
                  <View style={{ alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={iconColor} />
                    <TouchableOpacity
                      onPress={() => handleCancel(model.name)}
                      style={{ marginTop: 6 }}
                    >
                      <Ionicons
                        name="close-circle"
                        size={20}
                        color={iconColor}
                      />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity onPress={() => handleDownload(model)}>
                    <Ionicons name="download" size={20} color={iconColor} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </View>
    );
  };

  /** Renders each item in the single FlatList */
  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'header') {
      return renderHeaderItem(item);
    }
    // else => model
    return renderModelItem(item.model);
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
        {/* Changed width from w-11/12 to w-[99%] below */}
        <View className="w-[99%] max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
          {/* Close button in corner */}
          <View style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
            <TouchableOpacity onPress={handleClose}>
              <Ionicons
                name="close"
                size={24}
                color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'}
              />
            </TouchableOpacity>
          </View>

          {/* Search box — filters by name/description substring */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colorScheme === 'dark' ? '#242424' : '#F0F0F0',
              borderRadius: 10,
              paddingHorizontal: 10,
              marginTop: 28,
              marginBottom: 8,
              marginRight: 32,
            }}
          >
            <Ionicons
              name="search"
              size={16}
              color={colorScheme === 'dark' ? '#9BA1A6' : '#6B7280'}
            />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search models…"
              placeholderTextColor={colorScheme === 'dark' ? '#6B7280' : '#9BA1A6'}
              style={{
                flex: 1,
                paddingVertical: 8,
                paddingHorizontal: 8,
                color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                fontSize: 14,
              }}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
                <Ionicons
                  name="close-circle"
                  size={16}
                  color={colorScheme === 'dark' ? '#9BA1A6' : '#6B7280'}
                />
              </TouchableOpacity>
            )}
          </View>

          {/* Single FlatList with all items */}
          <FlatList
            data={data}
            renderItem={renderItem}
            keyExtractor={(item, index) =>
              item.type === 'header'
                ? `header-${index}`
                : `model-${item.model.name}`
            }
            style={{ marginTop: 4, marginBottom: 12 }}
            removeClippedSubviews
            initialNumToRender={14}
            windowSize={7}
            maxToRenderPerBatch={8}
          />

          {/* Plus Icon to load local model positioned to the right */}
          <View className="flex-row justify-end">
            <TouchableOpacity
              onPress={handlePickLocalModel}
              className="p-3 rounded-full"
              style={{ backgroundColor: buttonBg }}
            >
              <Ionicons name="add" size={24} color={buttonTextColor} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

export default DownloadModel;
