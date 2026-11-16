// store/useCharactersSlice.ts

import { themedAlert } from '@/components/ThemedAlert';

export type Character = {
  id: string;
  name: string;
  subtitle: string;
  modelName: string;
  description: string;
  conversationStyle: string;
  /**
   * The setting/situation framing the chat (Character Card V2's `scenario`
   * field). Injected as a "# Scenario" block in the system prompt — one of
   * the top-3 fields for roleplay quality per SillyTavern community guides.
   */
  scenario?: string;
  /**
   * Optional opening line from the character creator (Chub.ai's
   * `first_message` field). Shown as the first assistant message when
   * the user starts a chat.
   */
  firstMessage?: string;
  /**
   * Per-card override for the system prompt rules. When present, replaces
   * MicroGpt's hardcoded rules — the creator usually knows their card best.
   * (Character Card V2 `system_prompt` field.)
   */
  systemPrompt?: string;
  /**
   * Per-card override for the post-history "stay in character" reminder.
   * When present, replaces MicroGpt's hardcoded reminder injected before
   * generation. (Character Card V2 `post_history_instructions` field.)
   */
  postHistoryInstructions?: string;
  publicId?: number | null;
  isReadOnly?: boolean;
  likes_count?: number;
  downloads_count?: number;
};

export type PublicCharacter = {
  id: number;
  user_id: string;
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
  /** Community characters this user reported; hidden from the public lists. */
  hiddenPublicCharacterIds: number[];

  addCharacter: (char: Omit<Character, 'id'>) => void;
  updateCharacter: (
    id: string,
    updates: Partial<Omit<Character, 'id'>>
  ) => void;
  deleteCharacter: (id: string) => void;
  setActiveCharacter: (charId: string | null) => void;

  setLikedCharacters: (chars: PublicCharacter[]) => void;
  removeLikedCharacter: (charId: number) => void;
  hidePublicCharacter: (charId: number) => void;

  addOrUpdatePublicCharacterAsLocal: (pubChar: PublicCharacter) => void;
  removeLocalPublicCharacter: (publicId: number) => void;

  setEphemeralPublicCharacter: (pubChar: PublicCharacter | null) => void;
  setActiveFromEphemeralPublicChar: () => void;
}

const createCharactersSlice = (set: any, get: any): CharactersSlice => ({
  characters: [],
  activeCharacter: null,
  likedPublicCharacters: [],
  ephemeralPublicCharacter: null,
  hiddenPublicCharacterIds: [],

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

    // Characters are persona overlays, not model bindings. We do NOT swap
    // selectedModel here — the user keeps whatever model is currently
    // loaded. If nothing is loaded, fall back to the character's preferred
    // model only as a convenience for first-time activation.
    // In combo mode, check selectedTextModel; in legacy mode, check selectedModel
    const comboMode = get().comboModeEnabled;
    const currentSelected = comboMode ? get().selectedTextModel : get().selectedModel;
    if (!currentSelected) {
      const downloadedNames = get().downloadedModels.map((f: string) =>
        f.replace('.gguf', '')
      );
      const candidate =
        get().models.find(
          (m: any) =>
            m.name === found.modelName && downloadedNames.includes(m.name),
        ) ||
        get().models.find((m: any) => downloadedNames.includes(m.name));
      if (!candidate) {
        themedAlert(
          'No Model Loaded',
          'Load a model first, then activate this character.',
        );
        return;
      }
      set({
        activeCharacter: found,
        selectedModel: candidate,
        ...(comboMode ? { selectedTextModel: candidate } : {}),
      });
      return;
    }
    set({ activeCharacter: found });
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

  hidePublicCharacter: (charId) => {
    set((state: any) =>
      state.hiddenPublicCharacterIds.includes(charId)
        ? {}
        : { hiddenPublicCharacterIds: [...state.hiddenPublicCharacterIds, charId] }
    );
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

    // Characters are persona overlays, not model bindings. Use whatever
    // model is currently loaded. Only fall back to selecting a model if
    // nothing is loaded yet (first-time activation convenience).
    const comboMode = get().comboModeEnabled;
    const currentSelected = comboMode ? get().selectedTextModel : get().selectedModel;
    let modelToUse = currentSelected;

    if (!modelToUse) {
      const downloadedNames = get().downloadedModels.map((f: string) =>
        f.replace('.gguf', '')
      );
      modelToUse =
        get().models.find(
          (m: any) =>
            m.name === pubChar.model_name && downloadedNames.includes(m.name),
        ) ||
        get().models.find((m: any) => downloadedNames.includes(m.name)) ||
        null;
      if (!modelToUse) {
        themedAlert(
          'No Model Loaded',
          'Load a model first, then activate this character.',
        );
        return;
      }
    }

    set({
      activeCharacter: {
        id: Date.now().toString(),
        name: pubChar.name,
        subtitle: pubChar.subtitle ?? '',
        modelName: modelToUse.name,
        description: pubChar.description,
        conversationStyle: pubChar.conversation_style,
        publicId: pubChar.id,
        isReadOnly: true,
        likes_count: pubChar.likes_count,
        downloads_count: pubChar.downloads_count,
      },
      ...(currentSelected ? {} : {
        selectedModel: modelToUse,
        ...(comboMode ? { selectedTextModel: modelToUse } : {}),
      }),
    });
  },

});

export default createCharactersSlice;
