// store/useChatSessionsSlice.ts

import { Alert } from 'react-native';

export type ChatMessage = {
  id: string;
  sender: 'User' | 'Model';
  message: string;
  isStreaming?: boolean;
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
      Alert.alert('Error', 'Could not find that chat session.');
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
    const state = get();
    set({
      chatHistory: state.chatHistory.map((msg: ChatMessage) =>
        msg.id === id
          ? typeof update === 'function'
            ? { ...msg, ...update(msg) }
            : { ...msg, ...update }
          : msg
      ),
      chatSessions: state.chatSessions.map((session: ChatSession) => ({
        ...session,
        messages: session.messages.map((msg: ChatMessage) =>
          msg.id === id
            ? typeof update === 'function'
              ? { ...msg, ...update(msg) }
              : { ...msg, ...update }
            : msg
        ),
      })),
    });
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
    });
  },
});

export default createChatSessionsSlice;
