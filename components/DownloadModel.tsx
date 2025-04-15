// app/(root)/components/DownloadModel.tsx
import React, { useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  useColorScheme,
  Alert,
  Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import FontAwesome6 from '@expo/vector-icons/FontAwesome6';
import * as DocumentPicker from 'expo-document-picker';
import { useStore, Model } from '@/store';

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
 * Returns icon name if ratio >= 0.5. Otherwise null (no icon).
 * ratio < 0.5 -> null
 * ratio < 0.7 -> 'warning'
 * ratio >= 0.7 -> 'close-circle'
 */
function getIconNameForRatio(
  ratio: number
): keyof typeof Ionicons.glyphMap | null {
  if (ratio < 0.5) return null;
  if (ratio < 0.7) return 'warning';
  return 'close-circle';
}

/** Returns icon color for ratio >= 0.5. */
function getColorByRatio(ratio: number): string {
  if (ratio < 0.5) return 'transparent'; // no icon if it's green
  if (ratio < 0.7) return '#CCAA00'; // yellow
  return '#CC0000'; // red
}

/** Helper to separate a set of Models into [downloaded, notDownloaded], preserving order. */
function splitDownloaded(models: Model[], downloadedList: string[]) {
  const downloaded: Model[] = [];
  const notDownloaded: Model[] = [];
  for (const m of models) {
    const isDownloaded = downloadedList.includes(`${m.name}.gguf`);
    if (isDownloaded) downloaded.push(m);
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
};

const DownloadModel: React.FC<Props> = ({
  visible,
  onClose,
  onUseModel,
  onEjectModel,
}) => {
  const colorScheme = useColorScheme();
  const {
    models,
    downloadedModels,
    downloadModel,
    deleteModel,
    downloadProgress,
    isDownloading,
    cancelDownload,
    currentDownloadModelName,
    setDidUserCloseDownloadModal,
    selectedModel,
    totalDeviceMemory,
    addLocalModel,
  } = useStore();

  // Single color used for icons in general (dark vs light)
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  // Button background and text color
  const buttonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const buttonTextColor = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  /**
   * Step 1: build arrays for builtIn, HF, local, preserving store order.
   * Then for each category: put downloaded items first, then not downloaded items.
   */
  const builtInModels = useMemo(() => {
    return models.filter((m) => m.source === 'builtIn');
  }, [models]);

  const hfModels = useMemo(() => {
    return models.filter((m) => m.source === 'huggingface');
  }, [models]);

  const localModels = useMemo(() => {
    return models.filter((m) => m.source === 'local');
  }, [models]);

  // We preserve the original order of each group, then do downloaded first, notDownloaded second.
  const makeOrderedArray = (group: Model[]) => {
    const groupNames = group.map((m) => m.name);
    // preserve store order
    const sortedGroup = models.filter((m) => groupNames.includes(m.name));
    const { downloaded, notDownloaded } = splitDownloaded(
      sortedGroup,
      downloadedModels
    );
    return [...downloaded, ...notDownloaded];
  };

  // Step 2: build a single data array with "header" items + "model" items
  const data: ListItem[] = [];

  // ============= BUILT-IN MODELS =============
  const builtInFinal = makeOrderedArray(builtInModels);
  if (builtInFinal.length > 0) {
    data.push({ type: 'header', title: 'Suggested Models' });
    for (const model of builtInFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= HF MODELS =============
  const hfFinal = makeOrderedArray(hfModels);
  if (hfFinal.length > 0) {
    data.push({ type: 'header', title: 'Hugging Face Models' });
    for (const model of hfFinal) {
      data.push({ type: 'model', model });
    }
  }

  // ============= LOCAL MODELS =============
  const localFinal = makeOrderedArray(localModels);
  if (localFinal.length > 0) {
    data.push({ type: 'header', title: 'Local Models' });
    for (const model of localFinal) {
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
      Alert.alert('Size Unknown', 'Model size not found. Proceed anyway?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'OK', onPress: () => doDownload(model) },
      ]);
      return;
    }
    const ratio = totalDeviceMemory > 0 ? bytes / totalDeviceMemory : 0;
    if (ratio >= 0.7) {
      Alert.alert(
        'High Risk of Crash',
        'This model is large relative to your device RAM. Proceed?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download',
            style: 'destructive',
            onPress: () => doDownload(model),
          },
        ]
      );
    } else if (ratio >= 0.5) {
      Alert.alert(
        'Potential Crash Risk',
        'This model is moderately large relative to your device RAM. Proceed?',
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
    Alert.alert(
      'Warning',
      'Model size is close to or exceeds your device memory. This may cause unexpected behaviour.'
    );
  };

  // Handler for picking a local gguf file using expo-document-picker
  const handlePickLocalModel = async () => {
    if (Platform.OS === 'web') {
      Alert.alert(
        'Not supported',
        'Local file picking is not supported on Web.'
      );
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        // User pressed the system's "Cancel" button
        return;
      }
      const doc = (result as any).assets?.[0] ?? result;
      if (!doc.uri) {
        Alert.alert('Error', 'No URI returned from DocumentPicker.');
        return;
      }
      let fileName: string =
        doc.name ?? doc.uri.split('/').pop() ?? 'untitled.gguf';

      if (!fileName.toLowerCase().endsWith('.gguf')) {
        Alert.alert(
          'Invalid File',
          'Please select a file with a .gguf extension.'
        );
        return;
      }
      await addLocalModel(doc.uri, fileName);
      Alert.alert('Success', `Local model "${fileName}" added!`);
    } catch (error: any) {
      console.warn('handlePickLocalModel error:', error);
      Alert.alert('Error', `Failed to pick file: ${error.message}`);
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
            color: colorScheme === 'dark' ? '#FFF' : '#000',
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

    const isDownloaded = downloadedModels.includes(`${model.name}.gguf`);
    const isDownloadingThisOne =
      isDownloading && currentDownloadModelName === model.name;
    const isSelected = selectedModel?.name === model.name;

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
            {model.description?.length ? (
              <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1">
                {model.description}
              </Text>
            ) : null}
            {model.size ? (
              <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1">
                Size: {model.size}
              </Text>
            ) : null}
            {isDownloaded && (
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
    <Modal visible={visible} transparent animationType="slide">
      <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
        {/* Changed width from w-11/12 to w-[99%] below */}
        <View className="w-[99%] max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
          {/* Close button in corner */}
          <View style={{ position: 'absolute', top: 8, right: 8, zIndex: 1 }}>
            <TouchableOpacity onPress={handleClose}>
              <Ionicons
                name="close"
                size={24}
                color={colorScheme === 'dark' ? '#FFF' : '#000'}
              />
            </TouchableOpacity>
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
