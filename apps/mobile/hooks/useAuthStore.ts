import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import type { AuthTokens, User } from '@landfinder/shared';
import { authApi } from '../services/api';

interface AuthState {
  user: User | null;
  tokens: AuthTokens | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  checkAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const TOKEN_KEY = 'landfinder_tokens';
const USER_KEY = 'landfinder_user';

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  tokens: null,
  isLoading: true,
  isAuthenticated: false,

  checkAuth: async () => {
    try {
      const tokensJson = await SecureStore.getItemAsync(TOKEN_KEY);
      const userJson = await SecureStore.getItemAsync(USER_KEY);

      if (tokensJson && userJson) {
        const tokens = JSON.parse(tokensJson) as AuthTokens;
        const user = JSON.parse(userJson) as User;

        // TODO: Validate token expiration and refresh if needed
        set({ tokens, user, isAuthenticated: true, isLoading: false });
      } else {
        set({ isLoading: false });
      }
    } catch (error) {
      console.error('Error checking auth:', error);
      set({ isLoading: false });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      const response = await authApi.login(email, password);

      if (response.data) {
        const { tokens, user } = response.data;
        await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
        set({ tokens, user, isAuthenticated: true, isLoading: false });
      } else {
        throw new Error(response.error?.message || 'Login failed');
      }
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  register: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      const response = await authApi.register(email, password);

      if (response.data) {
        const { tokens, user } = response.data;
        await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
        set({ tokens, user, isAuthenticated: true, isLoading: false });
      } else {
        throw new Error(response.error?.message || 'Registration failed');
      }
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      set({ user: null, tokens: null, isAuthenticated: false });
    } catch (error) {
      console.error('Error during logout:', error);
    }
  },
}));
