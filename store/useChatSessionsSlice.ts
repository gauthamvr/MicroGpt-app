// store/useChatSessionsSlice.ts

import { themedAlert } from '@/components/ThemedAlert';

export type ChatMessage = {
  id: string;
  sender: 'User' | 'Model';
  message: string;
  isStreaming?: boolean;
  imageUri?: string;
  /** True while an [IMG: ...] tag was detected and image is being generated */
  isGeneratingImage?: boolean;
  /** The prompt extracted from [IMG: ...], stored for display/retry */
  imagePrompt?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
};

// ADD "export" in front of interface so it can be imported
export interface ChatSessionsSlice {
  chatHistory: ChatMessage[];
  chatSessions: ChatSession[];
  currentSessionId: string | null;
  freshLaunch: boolean;
  didUserCloseDownloadModal: boolean;

  setDidUserCloseDownloadModal: (val: boolean) => void;

  clearAllSessions: () => void;
  startNewSession: () => string;
  startNewSessionOnAppOpen: () => void;
  switchToSession: (sessionId: string) => void;
  addChatMessage: (message: ChatMessage) => void;
  updateChatMessage: (
    id: string,
    update: Partial<ChatMessage> | ((prev: ChatMessage) => Partial<ChatMessage>)
  ) => void;
  removeSession: (sessionId: string) => void;
  resetAllUserData: () => void;
}

const createChatSessionsSlice = (set: any, get: any): ChatSessionsSlice => ({
  chatHistory: [],
  chatSessions: [],
  currentSessionId: null,
  freshLaunch: true,
  didUserCloseDownloadModal: false,

  setDidUserCloseDownloadModal: (val) => {
    set({ didUserCloseDownloadModal: val });
  },

  clearAllSessions: () => {
    set({
      chatSessions: [],
      currentSessionId: null,
      chatHistory: [],
    });
  },

  startNewSession: () => {
    const state = get();
    if (state.currentSessionId) {
      const current = state.chatSessions.find(
        (s: ChatSession) => s.id === state.currentSessionId
      );
      if (current && current.messages.length === 0) {
        set({
          chatSessions: state.chatSessions.filter(
            (s: ChatSession) => s.id !== current.id
          ),
          currentSessionId: null,
          chatHistory: [],
        });
      }
    }
    const newSessionId = Date.now().toString();
    const newSession: ChatSession = {
      id: newSessionId,
      title: '',
      messages: [],
    };
    set((s: any) => ({
      chatSessions: [...s.chatSessions, newSession],
      currentSessionId: newSessionId,
      chatHistory: [],
    }));
    return newSessionId;
  },

  // FIX: Only clear if there are NO existing sessions
  startNewSessionOnAppOpen: () => {
    const state = get();
    if (state.freshLaunch && state.chatSessions.length === 0) {
      set({
        chatSessions: [],
        currentSessionId: null,
        chatHistory: [],
      });
      state.startNewSession();
    }
    set({ freshLaunch: false });
  },

  switchToSession: (sessionId) => {
    const sessions = get().chatSessions;
    const foundSession = sessions.find((s: ChatSession) => s.id === sessionId);
    if (foundSession) {
      set({
        currentSessionId: sessionId,
        chatHistory: foundSession.messages,
      });
    } else {
      themedAlert('Error', 'Could not find that chat session.');
    }
  },

  addChatMessage: (message) => {
    const state = get();
    let sessionId = state.currentSessionId;
    if (!sessionId) {
      sessionId = state.startNewSession();
    }
    set({ chatHistory: [...state.chatHistory, message] });
    const updatedSessions = state.chatSessions.map((session: ChatSession) => {
      if (session.id === sessionId) {
        const newMessages = [...session.messages, message];
        let updatedTitle = session.title;
        // If this is the first user message => use it as the session title
        if (
          message.sender === 'User' &&
          session.messages.filter((m) => m.sender === 'User').length === 0
        ) {
          updatedTitle = message.message.slice(0, 60);
        }
        return {
          ...session,
          messages: newMessages,
          title: updatedTitle,
        };
      }
      return session;
    });
    set({ chatSessions: updatedSessions });
  },

  updateChatMessage: (id, update) => {
    // Hot path — called ~20×/sec during token streaming. The previous
    // implementation walked EVERY chatSession and rebuilt each session's
    // `messages` array on every call. With 20 sessions × 50 messages
    // that's ~1000 object allocations per flush × 20 flushes/sec =
    // 20 000 allocations per second just for session bookkeeping.
    // Over a 30-second story it pegged the JS thread hard enough for
    // Android to raise the "app isn't responding / force stop" dialog.
    //
    // Now we only rebuild the active session's `messages` (and only if
    // the message actually belongs to it). Non-active sessions keep
    // their existing object identity.
    const state = get();
    const applyUpdate = (msg: ChatMessage): ChatMessage =>
      typeof update === 'function'
        ? { ...msg, ...update(msg) }
        : { ...msg, ...update };

    let nextHistory = state.chatHistory;
    let historyChanged = false;
    const historyIdx = state.chatHistory.findIndex((m: ChatMessage) => m.id === id);
    if (historyIdx >= 0) {
      nextHistory = state.chatHistory.slice();
      nextHistory[historyIdx] = applyUpdate(nextHistory[historyIdx]);
      historyChanged = true;
    }

    let nextSessions = state.chatSessions;
    const activeId = state.currentSessionId;
    if (activeId && historyChanged) {
      const sessionIdx = state.chatSessions.findIndex((s: ChatSession) => s.id === activeId);
      if (sessionIdx >= 0) {
        nextSessions = state.chatSessions.slice();
        nextSessions[sessionIdx] = {
          ...nextSessions[sessionIdx],
          messages: nextHistory,
        };
      }
    } else if (!activeId && historyChanged) {
      // No active session (shouldn't happen during streaming) — fall back
      // to searching every session for the message.
      nextSessions = state.chatSessions.map((session: ChatSession) => {
        const i = session.messages.findIndex((m) => m.id === id);
        if (i < 0) return session;
        const msgs = session.messages.slice();
        msgs[i] = applyUpdate(msgs[i]);
        return { ...session, messages: msgs };
      });
    }

    if (!historyChanged && nextSessions === state.chatSessions) return;
    set({ chatHistory: nextHistory, chatSessions: nextSessions });
  },

  removeSession: (sessionId) => {
    set((state: any) => {
      const updatedSessions = state.chatSessions.filter(
        (s: ChatSession) => s.id !== sessionId
      );
      let updatedCurrentSessionId = state.currentSessionId;
      let updatedChatHistory = state.chatHistory;
      if (state.currentSessionId === sessionId) {
        updatedCurrentSessionId = null;
        updatedChatHistory = [];
      }
      return {
        chatSessions: updatedSessions,
        currentSessionId: updatedCurrentSessionId,
        chatHistory: updatedChatHistory,
      };
    });
  },

  resetAllUserData: () => {
    // Clears out user-specific data
    set({
      characters: [],
      likedPublicCharacters: [],
      ephemeralPublicCharacter: null,
      activeCharacter: null,
      chatSessions: [],
      currentSessionId: null,
      chatHistory: [],
      selectedModel: null,
      selectedTextModel: null,
      selectedImageGenModel: null,
    });
  },
});

export default createChatSessionsSlice;
