import type {
  ApiResponse,
  AuthSession,
  PaginatedResponse,
  Parcel,
  ParcelCandidates,
  ParcelInsight,
  SavedParcel,
  SearchCriteria,
  SearchJob,
  SearchResult,
  WaterRight,
} from '@lastbestland/shared';
import { useAuthStore } from '../hooks/useAuthStore';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

async function request(path: string, options: RequestInit = {}, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers });
}

async function toApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.ok) return (await response.json()) as ApiResponse<T>;
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return { success: false, error: { code: String(response.status), message: body.error?.message ?? 'Request failed' } };
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const { tokens, setSession, clearSession } = useAuthStore.getState();
  if (!tokens) return false;
  refreshInFlight ??= (async () => {
    const response = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    const result = await toApiResponse<AuthSession>(response);
    if (result.success && result.data) {
      await setSession(result.data);
      return true;
    }
    await clearSession();
    return false;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Calls the API with the ID token, refreshing the session once on a 401. */
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    let response = await request(path, options, useAuthStore.getState().tokens?.idToken);
    if (response.status === 401 && (await refreshSession())) {
      response = await request(path, options, useAuthStore.getState().tokens?.idToken);
    }
    if (response.status === 401) {
      await useAuthStore.getState().clearSession();
      return { success: false, error: { code: '401', message: 'Session expired' } };
    }
    return toApiResponse<T>(response);
  } catch {
    return { success: false, error: { code: 'NETWORK_ERROR', message: 'Could not reach the server' } };
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const authApi = {
  login: (email: string, password: string) => apiFetch<AuthSession>('/auth/login', post({ email, password })),
  register: (email: string, password: string) => apiFetch<AuthSession>('/auth/register', post({ email, password })),
};

export const searchApi = {
  submitSearch: (criteria: SearchCriteria) => apiFetch<SearchJob>('/search', post(criteria)),
  getSearchResults: (jobId: string, page = 1, pageSize = 20) =>
    apiFetch<PaginatedResponse<SearchResult>>(`/search/${jobId}/results?page=${page}&pageSize=${pageSize}`),
};

export const parcelApi = {
  lookupParcel: (q: string) => apiFetch<Parcel | ParcelCandidates>(`/parcels/lookup?q=${encodeURIComponent(q)}`),
  getParcel: (id: string) => apiFetch<Parcel>(`/parcels/${id}`),
  getWaterRights: (id: string) => apiFetch<WaterRight[]>(`/parcels/${id}/water-rights`),
  getInsights: (id: string) => apiFetch<ParcelInsight[]>(`/parcels/${id}/insights`),
};

export const userApi = {
  getSavedParcels: () => apiFetch<SavedParcel[]>('/user/saved'),
  saveParcel: (parcelId: string, notes?: string) => apiFetch<SavedParcel>(`/user/saved/${parcelId}`, post({ notes })),
  removeSavedParcel: (parcelId: string) => apiFetch<void>(`/user/saved/${parcelId}`, { method: 'DELETE' }),
  getSearchHistory: () => apiFetch<SearchJob[]>('/user/searches'),
};

/** Unwraps a successful response or throws its error message, for use with react-query. */
export function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.success || response.data === undefined) throw new Error(response.error?.message ?? 'Request failed');
  return response.data;
}
