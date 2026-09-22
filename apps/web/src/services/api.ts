import type {
  ApiResponse,
  AuthTokens,
  User,
  SearchCriteria,
  SearchJob,
  Parcel,
  ParcelCandidates,
  WaterRight,
  Listing,
  ParcelInsight,
  PaginatedResponse,
  SavedParcel,
  SearchResult,
  HuntingDistrict,
  StreamGauge,
  RoadAccess,
  UtilityAccess,
  EnvironmentalRisk,
  ConservationEasement,
  ListingStatus,
} from '@lastbestland/shared'
import { useStore } from '../store'

// SearchCriteria already includes bbox via shared types; alias for clarity at the call site
export type WebSearchCriteria = SearchCriteria

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

function getToken(): string | null {
  try {
    const stored = localStorage.getItem('lastbestland-session')
    if (!stored) return null
    const parsed = JSON.parse(stored) as { state?: { tokens?: AuthTokens } }
    const tokens = parsed?.state?.tokens
    return tokens?.idToken ?? tokens?.accessToken ?? null
  } catch {
    return null
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers })
    if (response.status === 401) {
      useStore.getState().clearAuth()
      window.location.replace('/auth')
      return { success: false, error: { code: '401', message: 'Session expired' } }
    }
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string }
      return {
        success: false,
        error: { code: String(response.status), message: errorBody.error?.message ?? errorBody.message ?? 'Request failed' },
      }
    }
    return response.json() as Promise<ApiResponse<T>>
  } catch {
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message: 'Could not reach the server' },
    }
  }
}

export const authApi = {
  login: (email: string, password: string) =>
    apiFetch<{ tokens: AuthTokens; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string) =>
    apiFetch<{ tokens: AuthTokens; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
}

export const searchApi = {
  submitSearch: (criteria: WebSearchCriteria) =>
    apiFetch<SearchJob>('/search', {
      method: 'POST',
      body: JSON.stringify(criteria),
    }),

  getSearchResults: (jobId: string, page = 1, pageSize = 100) =>
    apiFetch<PaginatedResponse<SearchResult>>(
      `/search/${jobId}/results?page=${page}&pageSize=${pageSize}`
    ),
}

export const parcelApi = {
  lookupParcel: (q: string) => apiFetch<Parcel | ParcelCandidates>(`/parcels/lookup?q=${encodeURIComponent(q)}`),
  getParcel: (id: string) => apiFetch<Parcel>(`/parcels/${id}`),
  getWaterRights: (id: string) => apiFetch<WaterRight[]>(`/parcels/${id}/water-rights`),
  getListings: (id: string) => apiFetch<Listing[]>(`/parcels/${id}/listings`),
  getInsights: (id: string) => apiFetch<ParcelInsight[]>(`/parcels/${id}/insights`),
  getHuntingDistricts: (id: string) => apiFetch<HuntingDistrict[]>(`/parcels/${id}/hunting-districts`),
  getStreamGauges: (id: string) => apiFetch<StreamGauge[]>(`/parcels/${id}/stream-gauges`),
  getRoadAccess: (id: string) => apiFetch<RoadAccess>(`/parcels/${id}/road-access`),
  getUtilities: (id: string) => apiFetch<UtilityAccess>(`/parcels/${id}/utilities`),
  getEnvironmentalRisk: (id: string) => apiFetch<EnvironmentalRisk>(`/parcels/${id}/environmental-risk`),
  getConservationEasements: (id: string) => apiFetch<ConservationEasement[]>(`/parcels/${id}/conservation-easements`),
  checkListingStatus: (id: string, opts?: { refresh?: boolean }) =>
    apiFetch<ListingStatus>(`/parcels/${id}/listing-status${opts?.refresh ? '?refresh=true' : ''}`),
}

// Aurora pauses after 10 idle minutes and takes about 20 seconds to come back.
// Calling this on load moves that wait off the user's first search.
export const warmupApi = {
  wakeDatabase: () => apiFetch<{ ready: boolean; resumeMs: number }>('/warmup'),
}

export const userApi = {
  getSavedParcels: () => apiFetch<SavedParcel[]>('/user/saved'),
  saveParcel: (parcelId: string, notes?: string) =>
    apiFetch<SavedParcel>(`/user/saved/${parcelId}`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    }),
  removeSavedParcel: (parcelId: string) =>
    apiFetch<void>(`/user/saved/${parcelId}`, { method: 'DELETE' }),
}
