// store/index.ts

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Slice imports
import createModelsSlice, {
  ModelsSlice,
  Model,
  ModelSource,
} from './useModelsSlice';

import createCharactersSlice, {
  CharactersSlice,
  Character,
  PublicCharacter,
} from './useCharactersSlice';

import createChatSessionsSlice, {
  ChatSessionsSlice,
} from './useChatSessionsSlice';

export type StoreState = ModelsSlice & CharactersSlice & ChatSessionsSlice;
// Re-export the Model/Character types so other files can import from '@/store'
export type { Model, ModelSource, Character, PublicCharacter };

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      ...createModelsSlice(set, get),
      ...createCharactersSlice(set, get),
      ...createChatSessionsSlice(set, get),
    }),
    {
      name: 'app-storage',
      storage: createJSONStorage(() => AsyncStorage),

      /**
       * Exclude transient properties so we do NOT keep re-selecting a potentially
       * bad model on the next app launch. We *do* persist lastUsedModelName, so
       * that we know which one was last successfully loaded.
       */
      partialize: (state) => {
        const {
          selectedModel, // Exclude from persist
          downloadResumables, // Probably exclude
          currentDownloadModelName,
          isDownloading,
          downloadProgress,
          pendingDownloads,

          ...rest
        } = state;
        return rest;
      },
    }
  )
);
