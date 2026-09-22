import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { AuthSession, AuthTokens, User } from '@lastbestland/shared';

const SESSION_KEY = 'lastbestland_session';

interface AuthState {
  user: User | null;
  tokens: AuthTokens | null;
  /** True until the stored session has been read on startup. */
  isRestoring: boolean;
  restoreSession: () => Promise<void>;
  setSession: (session: AuthSession) => Promise<void>;
  clearSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  tokens: null,
  isRestoring: true,

  restoreSession: async () => {
    try {
      const stored = await SecureStore.getItemAsync(SESSION_KEY);
      if (stored) {
        const { user, tokens } = JSON.parse(stored) as AuthSession;
        set({ user, tokens });
      }
    } catch (err) {
      console.error('Could not restore session:', err);
    } finally {
      set({ isRestoring: false });
    }
  },

  setSession: async (session) => {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
    set({ user: session.user, tokens: session.tokens });
  },

  clearSession: async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    set({ user: null, tokens: null });
  },
}));
