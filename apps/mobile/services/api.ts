import axios, { AxiosInstance } from 'axios';
import * as SecureStore from 'expo-secure-store';
import type {
  ApiResponse,
  AuthTokens,
  User,
  SearchCriteria,
  SearchResult,
  SearchJob,
  Parcel,
  WaterRight,
  Listing,
  ParcelInsight,
  PaginatedResponse,
  SavedParcel,
} from '@landfinder/shared';

// TODO: Update with actual API Gateway URL after deployment
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

const TOKEN_KEY = 'landfinder_tokens';

const createApiClient = (): AxiosInstance => {
  const client = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Request interceptor to add auth token
  client.interceptors.request.use(async (config) => {
    try {
      const tokensJson = await SecureStore.getItemAsync(TOKEN_KEY);
      if (tokensJson) {
        const tokens = JSON.parse(tokensJson) as AuthTokens;
        config.headers.Authorization = `Bearer ${tokens.accessToken}`;
      }
    } catch (error) {
      console.error('Error getting auth token:', error);
    }
    return config;
  });

  // Response interceptor for error handling
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 401) {
        // TODO: Implement token refresh logic
        await SecureStore.deleteItemAsync(TOKEN_KEY);
      }
      return Promise.reject(error);
    }
  );

  return client;
};

const apiClient = createApiClient();

// Auth API
export const authApi = {
  login: async (
    email: string,
    password: string
  ): Promise<ApiResponse<{ tokens: AuthTokens; user: User }>> => {
    const response = await apiClient.post('/auth/login', { email, password });
    return response.data;
  },

  register: async (
    email: string,
    password: string
  ): Promise<ApiResponse<{ tokens: AuthTokens; user: User }>> => {
    const response = await apiClient.post('/auth/register', { email, password });
    return response.data;
  },

  refreshToken: async (refreshToken: string): Promise<ApiResponse<AuthTokens>> => {
    const response = await apiClient.post('/auth/refresh', { refreshToken });
    return response.data;
  },

  logout: async (): Promise<ApiResponse<void>> => {
    const response = await apiClient.post('/auth/logout');
    return response.data;
  },
};

// Search API
export const searchApi = {
  submitSearch: async (criteria: SearchCriteria): Promise<ApiResponse<SearchJob>> => {
    const response = await apiClient.post('/search', criteria);
    return response.data;
  },

  getSearchStatus: async (jobId: string): Promise<ApiResponse<SearchJob>> => {
    const response = await apiClient.get(`/search/${jobId}`);
    return response.data;
  },

  getSearchResults: async (
    jobId: string,
    page = 1,
    pageSize = 20
  ): Promise<ApiResponse<PaginatedResponse<SearchResult>>> => {
    const response = await apiClient.get(`/search/${jobId}/results`, {
      params: { page, pageSize },
    });
    return response.data;
  },
};

// Parcel API
export const parcelApi = {
  lookupParcel: async (q: string): Promise<ApiResponse<Parcel>> => {
    const response = await apiClient.get('/parcels/lookup', { params: { q } });
    return response.data;
  },

  getParcel: async (id: string): Promise<ApiResponse<Parcel>> => {
    const response = await apiClient.get(`/parcels/${id}`);
    return response.data;
  },

  getWaterRights: async (parcelId: string): Promise<ApiResponse<WaterRight[]>> => {
    const response = await apiClient.get(`/parcels/${parcelId}/water-rights`);
    return response.data;
  },

  getListings: async (parcelId: string): Promise<ApiResponse<Listing[]>> => {
    const response = await apiClient.get(`/parcels/${parcelId}/listings`);
    return response.data;
  },

  getInsights: async (parcelId: string): Promise<ApiResponse<ParcelInsight[]>> => {
    const response = await apiClient.get(`/parcels/${parcelId}/insights`);
    return response.data;
  },
};

// User API
export const userApi = {
  getSavedParcels: async (): Promise<ApiResponse<SavedParcel[]>> => {
    const response = await apiClient.get('/user/saved');
    return response.data;
  },

  saveParcel: async (
    parcelId: string,
    notes?: string
  ): Promise<ApiResponse<SavedParcel>> => {
    const response = await apiClient.post(`/user/saved/${parcelId}`, { notes });
    return response.data;
  },

  removeSavedParcel: async (parcelId: string): Promise<ApiResponse<void>> => {
    const response = await apiClient.delete(`/user/saved/${parcelId}`);
    return response.data;
  },

  getSearchHistory: async (): Promise<ApiResponse<SearchJob[]>> => {
    const response = await apiClient.get('/user/searches');
    return response.data;
  },
};
