// app/(root)/components/HuggingfaceDownloadModel.tsx
import React, { useMemo } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  FlatList,
  useColorScheme,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '@/store';

/**
 * Type describing each .gguf item from WebView
 */
type GgufItem = {
  href: string; // e.g. "https://huggingface.co/.../myModel.gguf?download=true"
  fileName: string; // e.g. "Llama-3.2-1B-Instruct-Q4_K_M.gguf"
  fileSize: string; // e.g. "808 MB", "2.48 GB"
};

/** Convert "2.48 GB" => number of bytes */
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
 * Sort .gguf items so that downloaded models are on top,
 * preserving original order among themselves.
 */
function sortGgufItems(ggufItems: GgufItem[], downloadedModels: string[]) {
  const downloaded = ggufItems.filter((i) =>
    downloadedModels.includes(i.fileName)
  );
  const notDownloaded = ggufItems.filter(
    (i) => !downloadedModels.includes(i.fileName)
  );
  return [...downloaded, ...notDownloaded];
}

/**
 * If ratio < 0.5 => null (no icon)
 * If ratio < 0.7 => warning (yellow)
 * If ratio >= 0.7 => close-circle (red)
 */
function getIconNameByRatio(
  ratio: number
): keyof typeof Ionicons.glyphMap | null {
  if (ratio < 0.5) return null;
  if (ratio < 0.7) return 'warning';
  return 'close-circle';
}

/**
 * For ratio < 0.5 => 'transparent' (no icon displayed),
 * For ratio < 0.7 => '#CCAA00' (yellow),
 * For ratio >= 0.7 => '#CC0000' (red)
 */
function getIconColorByRatio(ratio: number): string {
  if (ratio < 0.5) return 'transparent';
  if (ratio < 0.7) return '#CCAA00';
  return '#CC0000';
}

type Props = {
  visible: boolean;
  onClose: () => void;
  ggufItems: GgufItem[];
};

export default function HuggingfaceDownloadModel({
  visible,
  onClose,
  ggufItems,
}: Props) {
  const {
    downloadedModels,
    downloadProgress,
    isDownloading,
    currentDownloadModelName,
    cancelDownload,
    downloadModel,
    deleteModel,
    selectModel,
    selectedModel,
    totalDeviceMemory,
    setDidUserCloseDownloadModal,
  } = useStore();

  const colorScheme = useColorScheme();

  // Single icon color matching dark/light scheme
  const iconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  // "Use Model" button colors
  const useModelButtonBg = colorScheme === 'dark' ? '#FFFFFF' : '#000000';
  const useModelButtonText = colorScheme === 'dark' ? '#000000' : '#FFFFFF';

  // We want downloaded .gguf items at the top
  const sortedItems = useMemo(
    () => sortGgufItems(ggufItems, downloadedModels),
    [ggufItems, downloadedModels]
  );

  /** Called when user closes the modal. */
  const handleClose = () => {
    setDidUserCloseDownloadModal(true);
    onClose();
  };

  /**
   * Called when user taps "Download": memory-based checks
   */
  const handleDownload = (item: GgufItem) => {
    const bytes = parseFileSizeString(item.fileSize || '');
    if (bytes <= 0) {
      Alert.alert('Size Unknown', 'Cannot parse file size. Proceed anyway?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'OK', onPress: () => doDownload(item) },
      ]);
      return;
    }

    const ratio = totalDeviceMemory > 0 ? bytes / totalDeviceMemory : 0;
    if (ratio >= 0.7) {
      Alert.alert(
        'High Risk of Crash',
        'This model is large compared to your device RAM. Proceed anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Download',
            style: 'destructive',
            onPress: () => doDownload(item),
          },
        ]
      );
    } else if (ratio >= 0.5) {
      Alert.alert(
        'Potential Crash Risk',
        'This model is moderately large compared to your device RAM. Proceed anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', onPress: () => doDownload(item) },
        ]
      );
    } else {
      doDownload(item);
    }
  };

  // Actually call store.downloadModel
  const doDownload = (item: GgufItem) => {
    const modelName = item.fileName.replace('.gguf', '');
    downloadModel({
      name: modelName,
      url: item.href,
      description: `Size: ${item.fileSize || 'unknown'}`,
      source: 'huggingface',
    });
  };

  // Cancel
  const handleCancel = (item: GgufItem) => {
    const modelName = item.fileName.replace('.gguf', '');
    cancelDownload(modelName);
  };

  // Delete
  const handleDelete = (item: GgufItem) => {
    const modelName = item.fileName.replace('.gguf', '');
    deleteModel(modelName);
  };

  // Use Model
  const handleUseModel = (item: GgufItem) => {
    const modelName = item.fileName.replace('.gguf', '');
    selectModel({
      name: modelName,
      url: item.href,
      description: `Size: ${item.fileSize || 'unknown'}`,
      source: 'huggingface',
    });
    onClose();
  };

  /** When user taps the icon (yellow or red) */
  const handleIconTap = () => {
    Alert.alert(
      'Warning',
      'Model size is close to or exceeds your device memory. This may cause unexpected behaviour.'
    );
  };

  // Render each row
  const renderItem = ({ item }: { item: GgufItem }) => {
    // ratio => memory usage
    const fileBytes = parseFileSizeString(item.fileSize || '');
    const ratio = totalDeviceMemory > 0 ? fileBytes / totalDeviceMemory : 0;

    // Only show an icon if ratio >= 0.5
    const ratioIconName = getIconNameByRatio(ratio);
    const ratioIconColor = getIconColorByRatio(ratio);

    // States
    const modelName = item.fileName.replace('.gguf', '');
    const isDownloaded = downloadedModels.includes(item.fileName);
    const isDownloadingThisOne =
      isDownloading && currentDownloadModelName === modelName;
    const isSelected = selectedModel?.name === modelName;

    return (
      <View className="border-b border-theme-light-border dark:border-theme-dark-border py-3">
        {/* Row => left side + right icons */}
        <View className="flex-row items-start justify-between">
          {/* LEFT SIDE => ratio icon + file name, size, "Use Model" */}
          <View style={{ flex: 1, paddingRight: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              {/* If ratioIconName is not null => wrap Ionicons in a pressable to show warning */}
              {ratioIconName && (
                <TouchableOpacity
                  onPress={handleIconTap}
                  style={{ marginRight: 8 }}
                >
                  <Ionicons
                    name={ratioIconName}
                    size={16}
                    color={ratioIconColor}
                  />
                </TouchableOpacity>
              )}
              <Text
                className="text-base font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary"
                style={{ flex: 1 }}
              >
                {item.fileName}
              </Text>
            </View>

            {/* Size */}
            <Text className="text-sm text-theme-light-text-secondary dark:text-theme-dark-text-secondary mt-1">
              Size: {item.fileSize || 'Unknown'}
            </Text>

            {/* If downloaded => "Use Model" button */}
            {isDownloaded && (
              <TouchableOpacity
                onPress={() => handleUseModel(item)}
                className="mt-2 p-2 w-24 items-center rounded-full"
                style={{ backgroundColor: useModelButtonBg }}
              >
                <Text
                  className="font-bold"
                  style={{ fontSize: 14, color: useModelButtonText }}
                >
                  Use Model
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* RIGHT SIDE => vertical icons */}
          <View className="flex-col items-end" style={{ width: 30 }}>
            {/* Downloaded => show trash */}
            {isDownloaded && (
              <TouchableOpacity onPress={() => handleDelete(item)}>
                <Ionicons name="trash" size={20} color={iconColor} />
              </TouchableOpacity>
            )}

            {/* If not downloaded => spinner/cancel or download */}
            {!isDownloaded && (
              <>
                {isDownloadingThisOne ? (
                  <View style={{ alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={iconColor} />
                    <TouchableOpacity
                      onPress={() => handleCancel(item)}
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
                  <TouchableOpacity onPress={() => handleDownload(item)}>
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

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View className="flex-1 bg-theme-light-background dark:bg-theme-dark-background bg-opacity-50 justify-center items-center p-4">
        {/* Changed width from w-11/12 to w-[99%] below */}
        <View className="w-[99%] max-h-[90%] rounded-lg p-4 bg-theme-light-input-background dark:bg-theme-dark-input-background">
          <Text className="text-xl font-bold text-theme-light-text-primary dark:text-theme-dark-text-primary mb-3">
            Found .gguf Files
          </Text>

          {/* Single scrollable FlatList (downloaded are at top via sortedItems) */}
          <FlatList
            data={sortedItems}
            renderItem={renderItem}
            keyExtractor={(item) => item.fileName}
            className="mb-4"
          />

          {/* Close Button */}
          <TouchableOpacity
            onPress={handleClose}
            className="self-end px-4 py-2 rounded-full"
            style={{
              backgroundColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
            }}
          >
            <Text
              className="font-bold"
              style={{
                color: colorScheme === 'dark' ? '#000000' : '#FFFFFF',
              }}
            >
              Close
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
