// store/useModelsSlice.ts
import { Alert, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Device from 'expo-device';
import { BACKEND_URL } from '@/constants';

export type ModelSource = 'builtIn' | 'huggingface' | 'local';

export type Model = {
  name: string;
  url: string;
  description: string;
  source: ModelSource;
  size?: string;
};

export interface ModelsSlice {
  models: Model[];
  downloadedModels: string[];
  selectedModel: Model | null;
  downloadProgress: Record<string, number>;
  isDownloading: boolean;
  hasAcceptedHuggingFaceTOS: boolean;

  currentDownloadModelName: string | null;
  downloadResumables: Record<string, FileSystem.DownloadResumable | null>;
  pendingDownloads: string[];

  totalDeviceMemory: number;

  lastUsedModelName: string | null;
  setLastUsedModelName: (modelName: string | null) => void;

  acceptHuggingFaceTOS: () => void;
  initializeModels: () => Promise<void>;
  detectDeviceMemory: () => Promise<void>;
  rescanDownloadedModels: () => Promise<void>;
  downloadModel: (model: Model) => Promise<void>;
  cancelDownload: (modelName: string) => Promise<void>;
  deleteModel: (modelName: string) => Promise<void>;
  selectModel: (model: Model | null) => void;

  didUserCloseDownloadModal?: boolean;
  setDidUserCloseDownloadModal?: (val: boolean) => void;

  addLocalModel: (fileUri: string, fileName: string) => Promise<void>;
}

const BACKEND = BACKEND_URL;

const DEFAULT_BUILTIN_MODELS: Model[] = [
  {
    name: 'Gemma-2-it-GGUF',
    url: 'https://huggingface.co/unsloth/gemma-2-it-GGUF/resolve/main/gemma-2-2b-it.q2_k.gguf',
    description: 'Google gemma model, optimized for mobile',
    source: 'builtIn',
    size: '1.23 GB',
  },
  {
    name: 'Llama-3.2-1B-l',
    url: 'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q2_K.gguf',
    description: 'Llama model with 1 billion parameters, optimized for mobile',
    source: 'builtIn',
    size: '581 MB',
  },
  {
    name: 'Llama-3.2-1B',
    url: 'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    description: 'Llama model with 1 billion parameters, optimized for mobile',
    source: 'builtIn',
    size: '808 MB',
  },
  {
    name: 'Llama-3.2-3B',
    url: 'https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    description: 'Llama model with 3 billion parameters, optimized for mobile',
    source: 'builtIn',
    size: '2.02 GB',
  },
  {
    name: 'Llama-3.1-8B',
    url: 'https://huggingface.co/unsloth/Llama-3.1-Tulu-3-8B-GGUF/resolve/main/Llama-3.1-Tulu-3-8B-Q2_K.gguf',
    description: 'Llama model with 8 billion parameters, optimized for mobile',
    source: 'builtIn',
    size: '3.18 GB',
  },
  {
    name: 'Qwen2.5-Coder-0.5B',
    url: 'https://huggingface.co/unsloth/Qwen2.5-Coder-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-0.5B-Instruct-Q8_0.gguf',
    description: 'Qwen model, optimized for mobile coding',
    source: 'builtIn',
    size: '531 MB',
  },
  {
    name: 'Qwen2.5-Coder-7B',
    url: 'https://huggingface.co/unsloth/Qwen2.5-Coder-7B-Instruct-128K-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q2_K.gguf',
    description: 'Qwen model, optimized for mobile coding',
    source: 'builtIn',
    size: '3.02 GB',
  },
  {
    name: 'DeepSeek-R1-Distill-Llama-8B',
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF/resolve/main/DeepSeek-R1-Distill-Llama-8B-Q2_K.gguf',
    description:
      'DeepSeek-R1-Distill model fine-tuned based on open-source models',
    source: 'builtIn',
    size: '3.18 GB',
  },
  {
    name: 'DeepSeek-R1-Distill-Qwen-7B',
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-7B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-7B-Q2_K.gguf',
    description:
      'DeepSeek-R1-Distill model fine-tuned based on open-source models',
    source: 'builtIn',
    size: '3.02 GB',
  },
  {
    name: 'DeepSeek-R1-Distill-Qwen-1.5B',
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q8_0.gguf',
    description:
      'DeepSeek-R1-Distill model fine-tuned based on open-source models',
    source: 'builtIn',
    size: '1.89 GB',
  },
  {
    name: 'DeepSeek-R1-Distill-Qwen-1.5B-l',
    url: 'https://huggingface.co/unsloth/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q2_K_L.gguf',
    description:
      'DeepSeek-R1-Distill model fine-tuned based on open-source models',
    source: 'builtIn',
    size: '808 MB',
  },
];

const createModelsSlice = (set: any, get: any): ModelsSlice => ({
  models: [...DEFAULT_BUILTIN_MODELS],

  downloadedModels: [],
  selectedModel: null,
  downloadProgress: {},
  isDownloading: false,
  hasAcceptedHuggingFaceTOS: false,

  currentDownloadModelName: null,
  downloadResumables: {},
  pendingDownloads: [],

  totalDeviceMemory: 0,

  lastUsedModelName: null,
  setLastUsedModelName: (modelName) => {
    set({ lastUsedModelName: modelName });
  },

  didUserCloseDownloadModal: false,
  setDidUserCloseDownloadModal: (val) => {
    set({ didUserCloseDownloadModal: val });
  },

  acceptHuggingFaceTOS: () => {
    set({ hasAcceptedHuggingFaceTOS: true });
  },

  detectDeviceMemory: async () => {
    try {
      const mem = Device.totalMemory;
      if (typeof mem === 'number') {
        set({ totalDeviceMemory: mem });
      } else {
        set({ totalDeviceMemory: 0 });
      }
    } catch {
      set({ totalDeviceMemory: 0 });
    }
  },

  initializeModels: async () => {
    const downloadFolder = `${FileSystem.documentDirectory}Downloads/`;
    try {
      await get().detectDeviceMemory();

      // Ensure the Downloads folder
      const dirInfo = await FileSystem.getInfoAsync(downloadFolder);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(downloadFolder, {
          intermediates: true,
        });
      }

      // Remove any partial (pending) files from previous runs
      const pending = get().pendingDownloads;
      for (const modelName of pending) {
        try {
          await FileSystem.deleteAsync(
            `${downloadFolder}${modelName}.gguf.part`,
            {
              idempotent: true,
            }
          );
        } catch {}
      }
      set({ pendingDownloads: [] });

      // Re-scan existing .gguf
      const files = await FileSystem.readDirectoryAsync(downloadFolder);
      const validated: string[] = [];
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.gguf')) {
          // ignore partial or other files
          continue;
        }
        const filePath = downloadFolder + f;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists && info.size && info.size > 1024) {
          validated.push(f);
        } else {
          await FileSystem.deleteAsync(filePath, { idempotent: true });
        }
      }
      set({
        downloadedModels: validated, // e.g. ["MyModel.gguf", ...]
        isDownloading: false,
        currentDownloadModelName: null,
        downloadProgress: {},
        downloadResumables: {},
      });

      // Merge newly added built-in models if needed
      const currentModels = get().models;
      const mergedModels = [...currentModels];
      for (const defModel of DEFAULT_BUILTIN_MODELS) {
        const alreadyExists = mergedModels.some(
          (m) => m.name === defModel.name
        );
        if (!alreadyExists) {
          mergedModels.push(defModel);
        }
      }
      set({ models: mergedModels });
    } catch (error) {
      console.error('Error initializing models:', error);
      Alert.alert('Error', 'Failed to initialize models.');
    }
  },

  rescanDownloadedModels: async () => {
    try {
      const folder = `${FileSystem.documentDirectory}Downloads/`;
      const files = await FileSystem.readDirectoryAsync(folder);
      const validated: string[] = [];
      for (const f of files) {
        if (!f.toLowerCase().endsWith('.gguf')) {
          // skip partial or other random files
          continue;
        }
        const filePath = folder + f;
        const info = await FileSystem.getInfoAsync(filePath);
        if (info.exists && info.size && info.size > 1024) {
          validated.push(f);
        } else {
          await FileSystem.deleteAsync(filePath, { idempotent: true });
        }
      }
      set({ downloadedModels: validated });
    } catch (err) {
      console.warn('Error rescanning downloads:', err);
    }
  },

  downloadModel: async (model) => {
    const { downloadResumables, currentDownloadModelName } = get();
    if (currentDownloadModelName) {
      Alert.alert(
        'Download in progress',
        `Currently downloading "${currentDownloadModelName}". Please cancel or wait.`
      );
      return;
    }
    if (downloadResumables[model.name]) {
      Alert.alert(
        'Download in progress',
        `Already downloading ${model.name}...`
      );
      return;
    }

    set({
      isDownloading: true,
      currentDownloadModelName: model.name,
    });
    set((s: any) => ({
      pendingDownloads: [...s.pendingDownloads, model.name],
    }));

    const downloadFolder = `${FileSystem.documentDirectory}Downloads/`;
    // We first download to .gguf.part, so that partial file won't be recognized as complete
    const partialFileUri = `${downloadFolder}${model.name}.gguf.part`;
    const finalFileUri = `${downloadFolder}${model.name}.gguf`;

    try {
      // If final .gguf is already present, skip
      const fileInfo = await FileSystem.getInfoAsync(finalFileUri);
      if (fileInfo.exists && fileInfo.size && fileInfo.size > 1024) {
        Alert.alert(
          'Already Downloaded',
          `${model.name} is already on device.`
        );
        set({
          selectedModel: model,
          isDownloading: false,
          currentDownloadModelName: null,
        });
        return;
      } else {
        // Clean up partial if it exists
        await FileSystem.deleteAsync(partialFileUri, { idempotent: true });
        await FileSystem.deleteAsync(finalFileUri, { idempotent: true });
      }

      const downloadResumable = FileSystem.createDownloadResumable(
        model.url,
        partialFileUri,
        {},
        (progressData) => {
          const { totalBytesWritten, totalBytesExpectedToWrite } = progressData;
          let progress = 0;
          if (totalBytesExpectedToWrite > 0) {
            progress = totalBytesWritten / totalBytesExpectedToWrite;
          }
          set((state: any) => ({
            downloadProgress: {
              ...state.downloadProgress,
              [model.name]: progress,
            },
          }));
        }
      );

      set((state: any) => ({
        downloadResumables: {
          ...state.downloadResumables,
          [model.name]: downloadResumable,
        },
      }));

      // start the download
      const downloadResult = await downloadResumable.downloadAsync();
      const stillActive = get().currentDownloadModelName === model.name;
      if (!stillActive) {
        // user probably canceled => bail out
        return;
      }
      if (!downloadResult?.uri) {
        throw new Error('No URI returned, partial or failed download.');
      }

      // set final progress to 1.0
      set((s: any) => ({
        downloadProgress: {
          ...s.downloadProgress,
          [model.name]: 1,
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 600)); // a short delay

      // check final file size
      const partialCheck = await FileSystem.getInfoAsync(partialFileUri);
      if (!partialCheck.exists || (partialCheck.size ?? 0) < 1024) {
        throw new Error('File is too small—likely incomplete download.');
      }

      // rename from .gguf.part => .gguf
      await FileSystem.moveAsync({
        from: partialFileUri,
        to: finalFileUri,
      });

      // Another final check
      const finalCheck = await FileSystem.getInfoAsync(finalFileUri);
      if (!finalCheck.exists || (finalCheck.size ?? 0) < 1024) {
        throw new Error('Failed to rename or incomplete file.');
      }

      // update store
      const state = get();
      let finalDescription = model.description;
      if (model.source === 'huggingface') {
        finalDescription = 'downloaded from hugging face';
      }
      const updatedModels = state.models.filter(
        (m: Model) => m.name !== model.name
      );
      updatedModels.push({ ...model, description: finalDescription });

      set(() => ({
        models: updatedModels,
        downloadedModels: [...state.downloadedModels, `${model.name}.gguf`],
        selectedModel: { ...model, description: finalDescription },
        isDownloading: false,
        currentDownloadModelName: null,
      }));

      set((s: any) => ({
        downloadResumables: {
          ...s.downloadResumables,
          [model.name]: null,
        },
        pendingDownloads: s.pendingDownloads.filter(
          (m: string) => m !== model.name
        ),
      }));
    } catch (error: any) {
      if (!error?.message?.toLowerCase().includes('canceled-by-user')) {
        const didUserCloseDownloadModal = get().didUserCloseDownloadModal;
        if (!didUserCloseDownloadModal && Platform.OS !== 'web') {
          Alert.alert(
            'Download Failed',
            'An error occurred while downloading.'
          );
        }
      }
      // Clean partial
      try {
        await FileSystem.deleteAsync(partialFileUri, { idempotent: true });
      } catch (err) {
        // console.log('Error cleaning partial file:', err);
      }

      // Rescan to ensure not recognized as complete
      await get().rescanDownloadedModels();

      set((s: any) => ({
        downloadResumables: {
          ...s.downloadResumables,
          [model.name]: null,
        },
        downloadProgress: {
          ...s.downloadProgress,
          [model.name]: 0,
        },
        isDownloading: false,
        currentDownloadModelName: null,
        pendingDownloads: s.pendingDownloads.filter(
          (m: string) => m !== model.name
        ),
      }));
    }
  },

  cancelDownload: async (modelName) => {
    const { downloadResumables, currentDownloadModelName } = get();
    if (!currentDownloadModelName) {
      return;
    }
    if (currentDownloadModelName !== modelName) {
      return;
    }
    const resumable = downloadResumables[modelName];
    if (!resumable) {
      return;
    }
    try {
      await resumable.cancelAsync();
      const downloadFolder = `${FileSystem.documentDirectory}Downloads/`;
      const partialFileUri = `${downloadFolder}${modelName}.gguf.part`;
      await FileSystem.deleteAsync(partialFileUri, { idempotent: true });
      throw new Error('canceled-by-user');
    } catch (err) {
      console.warn(`CancelDownload for ${modelName} ->`, err);
    }
  },

  deleteModel: async (modelName) => {
    const state = get();
    const modelToDelete = state.models.find((m: Model) => m.name === modelName);
    if (!modelToDelete) {
      Alert.alert('Error', 'Model not found in store.');
      return;
    }

    const downloadFolder = `${FileSystem.documentDirectory}Downloads/`;
    const fileUri = `${downloadFolder}${modelName}.gguf`;
    const partialFileUri = `${fileUri}.part`;

    try {
      await FileSystem.deleteAsync(fileUri, { idempotent: true });
      await FileSystem.deleteAsync(partialFileUri, { idempotent: true });

      const checkDeleted = await FileSystem.getInfoAsync(fileUri);
      if (checkDeleted.exists) {
        console.warn(`File is still present after delete: ${fileUri}`);
      } else {
        // console.log(`Successfully deleted model file: ${fileUri}`);
      }

      await state.rescanDownloadedModels();
    } catch (error) {
      console.warn('Could not delete file from FS:', error);
    }

    const newDownloaded = state.downloadedModels.filter(
      (f: string) => f !== `${modelName}.gguf`
    );

    let updatedModels = state.models;
    // If it's a huggingface model, remove entirely
    if (modelToDelete.source === 'huggingface') {
      updatedModels = state.models.filter((m: Model) => m.name !== modelName);
    }
    // If it's local, remove from store as well
    if (modelToDelete.source === 'local') {
      updatedModels = state.models.filter((m: Model) => m.name !== modelName);
    }

    let newSelectedModel = state.selectedModel;
    if (newSelectedModel?.name === modelName) {
      newSelectedModel = null;
    }
    let newActiveCharacter = state.activeCharacter;
    if (newActiveCharacter?.modelName === modelName) {
      newActiveCharacter = null;
    }

    set({
      models: updatedModels,
      downloadedModels: newDownloaded,
      selectedModel: newSelectedModel,
      activeCharacter: newActiveCharacter,
    });

    Alert.alert('Deleted', `${modelName} removed from your device.`);
  },

  selectModel: (model) => {
    set(() => ({
      selectedModel: model,
      activeCharacter: null,
    }));
  },

  // Helper to copy the user-chosen .gguf file to the app's Downloads folder and add to store
  addLocalModel: async (fileUri: string, fileName: string) => {
    try {
      const downloadFolder = `${FileSystem.documentDirectory}Downloads/`;
      // In case user picks "foo.gguf", remove the extension from the "name"
      let modelName = fileName.toLowerCase().endsWith('.gguf')
        ? fileName.slice(0, -5)
        : fileName;

      // If there's any weird spacing or special chars, you can sanitize further if needed
      modelName = modelName.trim();

      // Final destination inside the app's Documents/Downloads
      const destination = `${downloadFolder}${modelName}.gguf`;

      // Copy the file over
      await FileSystem.copyAsync({
        from: fileUri,
        to: destination,
      });

      // Re-scan so that it's recognized in downloadedModels
      await get().rescanDownloadedModels();

      // Add to the `models` array as a "local" source
      set((state: any) => {
        // If a model with that name already exists, remove it to replace
        const newModels = state.models.filter(
          (m: Model) => m.name !== modelName
        );
        newModels.push({
          name: modelName,
          url: destination,
          description: 'Local model loaded from device',
          source: 'local',
        });
        return { models: newModels };
      });
    } catch (err) {
      console.warn('Error adding local model:', err);
      Alert.alert('Error', 'Failed to copy local model into Downloads folder.');
    }
  },
});

export default createModelsSlice;
