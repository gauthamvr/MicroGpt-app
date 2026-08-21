// store/index.ts

import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage is one of the heaviest operations available to an RN app.
 * Zustand's persist middleware writes on every state change, which
 * during token streaming (~20 mutations/sec for 30+ seconds) would
 * JSON.stringify the whole state and push it through the RN bridge 20
 * times per second — several hundred KB worth of work per tick. That's
 * the last remaining ANR contributor after we fixed updateChatMessage.
 *
 * Debounce setItem so the last write wins after a short idle window.
 * Reads and deletes are not debounced (they're rare).
 */
function createDebouncedAsyncStorage(delayMs: number): StateStorage {
  const pendingWrites = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const flush = async (key: string) => {
    timers.delete(key);
    const value = pendingWrites.get(key);
    if (value === undefined) return;
    pendingWrites.delete(key);
    try {
      await AsyncStorage.setItem(key, value);
    } catch (err) {
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.warn('[store] AsyncStorage setItem failed', err);
      }
    }
  };
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => {
      pendingWrites.set(key, value);
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(key, setTimeout(() => void flush(key), delayMs));
    },
    removeItem: async (key) => {
      const existing = timers.get(key);
      if (existing) {
        clearTimeout(existing);
        timers.delete(key);
      }
      pendingWrites.delete(key);
      await AsyncStorage.removeItem(key);
    },
  };
}

// Slice imports
import createModelsSlice, {
  ModelsSlice,
  Model,
  ModelSource,
  ModelType,
  DownloadStats,
  DownloadPhase,
} from './useModelsSlice';
export {
  formatBytes,
  formatEta,
  parseFileSizeString,
  getModelType,
  isImageGenModel,
  detectImageGenFromFilename,
  getModelFileName,
  getRecommendedModelName,
} from './useModelsSlice';
export type { DownloadPhase } from './useModelsSlice';

import createCharactersSlice, {
  CharactersSlice,
  Character,
  PublicCharacter,
} from './useCharactersSlice';

import createChatSessionsSlice, {
  ChatSessionsSlice,
} from './useChatSessionsSlice';

import createGenSettingsSlice, {
  GenSettingsSlice,
  GenSettings,
  HardwareAccelMode,
  CharacterGreetingMode,
  defaultGenSettings,
} from './useGenSettingsSlice';

export type StoreState = ModelsSlice &
  CharactersSlice &
  ChatSessionsSlice &
  GenSettingsSlice;

// Re-export the Model/Character/Settings types so other files can import from '@/store'
export type {
  Model,
  ModelSource,
  ModelType,
  Character,
  PublicCharacter,
  DownloadStats,
  GenSettings,
  HardwareAccelMode,
  CharacterGreetingMode,
};
export { defaultGenSettings };

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      ...createModelsSlice(set, get),
      ...createCharactersSlice(set, get),
      ...createChatSessionsSlice(set, get),
      ...createGenSettingsSlice(set, get),
    }),
    {
      name: 'app-storage',
      // 800 ms debounce: rapid streaming collapses into one write per
      // idle window; normal user-initiated state changes still feel
      // instant on reload (first write happens ~0.8 s after last edit).
      storage: createJSONStorage(() => createDebouncedAsyncStorage(800)),

      /**
       * Exclude transient properties so we do NOT keep re-selecting a potentially
       * bad model on the next app launch. We *do* persist lastUsedModelName, so
       * that we know which one was last successfully loaded.
       *
       * genSettings IS persisted (all fields except forceFullRam, which is
       * reset via onRehydrateStorage below as a safety override).
       */
      partialize: (state) => {
        const {
          selectedModel, // Exclude from persist
          selectedTextModel, // Exclude from persist (transient)
          selectedImageGenModel, // Exclude from persist (transient)
          _activeDownloadTasks, // Non-serializable
          _activeDownloadPollers, // Non-serializable timer handles
          activeDownloads, // Non-serializable (Set)
          currentDownloadModelName,
          isDownloading,
          downloadProgress,
          downloadStats, // Live byte/speed stats — only valid in current session
          downloadPhase, // Transient phase — only valid in current session
          pendingDownloads,
          // resumableDownloads is rebuilt from disk via rescanResumableDownloads()
          // on every initializeModels() call. Persisting would risk drift if the
          // user manually deletes a .part file outside the app.
          resumableDownloads,
          // chatHistory is just a view of chatSessions[currentSessionId].messages;
          // re-deriving it on rehydrate saves serializing the same array twice
          // on every token flush.
          chatHistory,

          ...rest
        } = state;
        return rest;
      },

      /**
       * Runs after the persisted state is rehydrated from AsyncStorage.
       * Three jobs:
       *
       *  1. Merge defaults into genSettings so a user upgrading from an
       *     older app version (whose persisted state doesn't have the
       *     new fields like `characterGreeting`) still ends up with every
       *     field populated instead of `undefined`.
       *
       *  2. Force `forceFullRam` back to false on every cold start. It's
       *     a session-only safety override — if the user flipped it on
       *     last session and it caused an OOM, we don't want them stuck.
       *
       *  3. Migrate old `useGpuAcceleration` boolean to the new
       *     `hardwareAcceleration` enum. true → 'gpu', false → 'cpu'.
       */
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Rebuild chatHistory from the persisted currentSession (it's
        // excluded from the persist blob above to avoid double-write).
        if (state.currentSessionId) {
          const cur = state.chatSessions?.find(
            (s) => s.id === state.currentSessionId,
          );
          state.chatHistory = cur?.messages ?? [];
        } else {
          state.chatHistory = [];
        }

        const persisted = (state.genSettings ?? {}) as any;

        // Migrate old boolean GPU toggle → new hardware accel enum
        let migratedAccel: HardwareAccelMode | undefined;
        if (persisted.useGpuAcceleration !== undefined && persisted.hardwareAcceleration === undefined) {
          migratedAccel = persisted.useGpuAcceleration ? 'gpu' : 'auto';
          delete persisted.useGpuAcceleration;
        }

        // Migrate old characterGreeting 'auto' → 'scripted'. The setting
        // was split into 'scripted' (current auto behavior) and 'llm'
        // (model generates even when a scripted first_message exists).
        if (persisted.characterGreeting === 'auto') {
          persisted.characterGreeting = 'scripted';
        }

        state.genSettings = {
          ...defaultGenSettings,
          ...persisted,
          forceFullRam: false,
          ...(migratedAccel !== undefined ? { hardwareAcceleration: migratedAccel } : {}),
        };
      },
    }
  )
);
