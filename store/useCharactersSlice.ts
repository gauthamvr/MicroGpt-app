// store/useCharactersSlice.ts

import { Alert } from 'react-native';
import { BACKEND_URL } from '@/constants';

export type Character = {
  id: string;
  name: string;
  subtitle: string;
  modelName: string;
  description: string;
  conversationStyle: string;
  publicId?: number | null;
  isReadOnly?: boolean;
  likes_count?: number;
  downloads_count?: number;
};

export type PublicCharacter = {
  id: number;
  clerk_id: string;
  name: string;
  subtitle?: string;
  description: string;
  conversation_style: string;
  model_name: string;
  likes_count: number;
  downloads_count: number;
  created_at: string;
  updated_at: string;
};

// ADD "export" so we can import the interface
export interface CharactersSlice {
  characters: Character[];
  activeCharacter: Character | null;
  likedPublicCharacters: PublicCharacter[];
  ephemeralPublicCharacter: PublicCharacter | null;

  addCharacter: (char: Omit<Character, 'id'>) => void;
  updateCharacter: (
    id: string,
    updates: Partial<Omit<Character, 'id'>>
  ) => void;
  deleteCharacter: (id: string) => void;
  setActiveCharacter: (charId: string | null) => void;

  setLikedCharacters: (chars: PublicCharacter[]) => void;
  removeLikedCharacter: (charId: number) => void;

  addOrUpdatePublicCharacterAsLocal: (pubChar: PublicCharacter) => void;
  removeLocalPublicCharacter: (publicId: number) => void;

  setEphemeralPublicCharacter: (pubChar: PublicCharacter | null) => void;
  setActiveFromEphemeralPublicChar: () => void;

  loadUserPublishedCharacters: (clerkId: string) => Promise<void>;
}

const BACKEND = BACKEND_URL;

const createCharactersSlice = (set: any, get: any): CharactersSlice => ({
  characters: [],
  activeCharacter: null,
  likedPublicCharacters: [],
  ephemeralPublicCharacter: null,

  addCharacter: (char) => {
    const newChar: Character = {
      id: Date.now().toString(),
      publicId: null,
      ...char,
      subtitle: char.subtitle ?? '',
    };
    set((s: any) => ({
      characters: [...s.characters, newChar],
    }));
  },

  updateCharacter: (id, updates) => {
    set((s: any) => ({
      characters: s.characters.map((c: Character) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    }));
  },

  deleteCharacter: (id) => {
    set((s: any) => ({
      characters: s.characters.filter((c: Character) => c.id !== id),
      activeCharacter: s.activeCharacter?.id === id ? null : s.activeCharacter,
    }));
  },

  setActiveCharacter: (charId) => {
    if (charId === null) {
      set({ activeCharacter: null });
      return;
    }
    const found = get().characters.find((c: Character) => c.id === charId);
    if (!found) return;

    const downloadedNames = get().downloadedModels.map((f: string) =>
      f.replace('.gguf', '')
    );
    let candidate = get().models.find(
      (m: any) => m.name === found.modelName && downloadedNames.includes(m.name)
    );
    if (!candidate) {
      const available = get().models.filter((m: any) =>
        downloadedNames.includes(m.name)
      );
      if (available.length === 0) {
        Alert.alert(
          'No Models',
          'No models are available. Please download a model first.'
        );
        return;
      } else {
        candidate = available[0];
      }
    }
    set({
      activeCharacter: found,
      selectedModel: candidate,
    });
  },

  setLikedCharacters: (chars) => {
    set({ likedPublicCharacters: chars });
  },

  removeLikedCharacter: (charId) => {
    set((state: any) => ({
      likedPublicCharacters: state.likedPublicCharacters.filter(
        (c: PublicCharacter) => c.id !== charId
      ),
    }));
  },

  addOrUpdatePublicCharacterAsLocal: (pubChar) => {
    set((s: any) => {
      const existing = s.characters.find(
        (c: Character) => c.publicId === pubChar.id
      );
      if (existing) {
        return {
          characters: s.characters.map((c: Character) =>
            c.publicId === pubChar.id
              ? {
                  ...c,
                  name: pubChar.name,
                  subtitle: pubChar.subtitle ?? '',
                  modelName: pubChar.model_name,
                  description: pubChar.description,
                  conversationStyle: pubChar.conversation_style,
                  isReadOnly: true,
                  likes_count: pubChar.likes_count,
                  downloads_count: pubChar.downloads_count,
                }
              : c
          ),
        };
      } else {
        const newLocalChar: Character = {
          id: Date.now().toString(),
          name: pubChar.name,
          subtitle: pubChar.subtitle ?? '',
          modelName: pubChar.model_name,
          description: pubChar.description,
          conversationStyle: pubChar.conversation_style,
          publicId: pubChar.id,
          isReadOnly: true,
          likes_count: pubChar.likes_count,
          downloads_count: pubChar.downloads_count,
        };
        return { characters: [...s.characters, newLocalChar] };
      }
    });
  },

  removeLocalPublicCharacter: (publicId) => {
    set((s: any) => ({
      characters: s.characters.filter(
        (c: Character) => c.publicId !== publicId
      ),
    }));
  },

  setEphemeralPublicCharacter: (pubChar) => {
    set({ ephemeralPublicCharacter: pubChar });
  },

  setActiveFromEphemeralPublicChar: () => {
    const pubChar = get().ephemeralPublicCharacter;
    if (!pubChar) return;

    const downloadedNames = get().downloadedModels.map((f: string) =>
      f.replace('.gguf', '')
    );
    let candidate = get().models.find(
      (m: any) =>
        m.name === pubChar.model_name && downloadedNames.includes(m.name)
    );
    if (!candidate) {
      const available = get().models.filter((m: any) =>
        downloadedNames.includes(m.name)
      );
      if (available.length === 0) {
        Alert.alert(
          'No Models',
          'No models are available. Please download a model first.'
        );
        return;
      } else {
        candidate = available[0];
      }
    }
    set({
      activeCharacter: {
        id: Date.now().toString(),
        name: pubChar.name,
        subtitle: pubChar.subtitle ?? '',
        modelName: candidate?.name ?? pubChar.model_name,
        description: pubChar.description,
        conversationStyle: pubChar.conversation_style,
        publicId: pubChar.id,
        isReadOnly: true,
        likes_count: pubChar.likes_count,
        downloads_count: pubChar.downloads_count,
      },
      selectedModel: candidate || null,
    });
  },

  loadUserPublishedCharacters: async (clerkId) => {
    try {
      const res = await fetch(`${BACKEND}/publishedCharacters/${clerkId}`);
      if (!res.ok) {
        throw new Error('Failed to fetch user-published characters');
      }
      const data = await res.json();
      const chars: PublicCharacter[] = data.data || [];
      set((s: any) => {
        const newChars = [...s.characters];
        for (const pubChar of chars) {
          const existingIndex = newChars.findIndex(
            (c: Character) => c.publicId === pubChar.id
          );
          const base = {
            name: pubChar.name,
            subtitle: pubChar.subtitle ?? '',
            modelName: pubChar.model_name,
            description: pubChar.description,
            conversationStyle: pubChar.conversation_style,
            publicId: pubChar.id,
            isReadOnly: false,
            likes_count: pubChar.likes_count,
            downloads_count: pubChar.downloads_count,
          };
          if (existingIndex >= 0) {
            newChars[existingIndex] = {
              ...newChars[existingIndex],
              ...base,
            };
          } else {
            newChars.push({
              id: Date.now().toString(),
              ...base,
            });
          }
        }
        return { characters: newChars };
      });
    } catch (err) {
      console.error('loadUserPublishedCharacters error:', err);
    }
  },
});

export default createCharactersSlice;
