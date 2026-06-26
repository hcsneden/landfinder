import type {
  ApiResponse,
  AuthTokens,
  User,
  SearchCriteria,
  SearchJob,
  Parcel,
  WaterRight,
  Listing,
  ParcelInsight,
  PaginatedResponse,
  SavedParcel,
  SearchResult,
  HuntingDistrict,
  StreamGauge,
  RoadAccess,
} from '@landfinder/shared'
import type { BBox } from '../store'

export interface WebSearchCriteria extends SearchCriteria {
  bbox?: BBox
}

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

function getToken(): string | null {
  try {
    const stored = localStorage.getItem('landfinder-session')
    if (!stored) return null
    const parsed = JSON.parse(stored) as { state?: { tokens?: AuthTokens } }
    const t = parsed?.state?.tokens
    return t?.idToken ?? t?.accessToken ?? null
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
    const res = await fetch(`${API_BASE_URL}${path}`, { ...options, headers })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { message?: string }; message?: string }
      return {
        success: false,
        error: { code: String(res.status), message: body.error?.message ?? body.message ?? 'Request failed' },
      }
    }
    return res.json() as Promise<ApiResponse<T>>
  } catch (err) {
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
  lookupParcel: (q: string) => apiFetch<Parcel>(`/parcels/lookup?q=${encodeURIComponent(q)}`),
  getParcel: (id: string) => apiFetch<Parcel>(`/parcels/${id}`),
  getWaterRights: (id: string) => apiFetch<WaterRight[]>(`/parcels/${id}/water-rights`),
  getListings: (id: string) => apiFetch<Listing[]>(`/parcels/${id}/listings`),
  getInsights: (id: string) => apiFetch<ParcelInsight[]>(`/parcels/${id}/insights`),
  getHuntingDistricts: (id: string) => apiFetch<HuntingDistrict[]>(`/parcels/${id}/hunting-districts`),
  getStreamGauges: (id: string) => apiFetch<StreamGauge[]>(`/parcels/${id}/stream-gauges`),
  getRoadAccess: (id: string) => apiFetch<RoadAccess>(`/parcels/${id}/road-access`),
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
