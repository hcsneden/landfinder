import type {
  ApiResponse,
  AuthSession,
  ConservationEasements,
  EnvironmentalRisk,
  GroundwaterInfo,
  HuntingDistrict,
  ListingStatus,
  PaginatedResponse,
  Parcel,
  ParcelCandidates,
  ParcelInsight,
  RoadAccess,
  SavedParcel,
  SearchCriteria,
  SearchJob,
  SearchResult,
  SoilInfo,
  StreamGauge,
  UtilityAccess,
  WaterRight,
} from '@lastbestland/shared'
import { useStore } from '../store'

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

async function request(path: string, options: RequestInit = {}, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${API_BASE_URL}${path}`, { ...options, headers })
}

async function toApiResponse<T>(response: Response): Promise<ApiResponse<T>> {
  if (response.ok) return response.json() as Promise<ApiResponse<T>>
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  return {
    success: false,
    error: { code: String(response.status), message: body.error?.message ?? 'Request failed' },
  }
}

// Only one refresh runs at a time so parallel 401s share it.
let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  const { tokens, setAuth, clearAuth } = useStore.getState()
  if (!tokens) return false
  refreshInFlight ??= (async () => {
    const response = await request('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    })
    const result = await toApiResponse<AuthSession>(response)
    if (result.success && result.data) {
      setAuth(result.data)
      return true
    }
    clearAuth()
    return false
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * Calls the API with the current ID token. On a 401 it refreshes the session
 * once and retries. If the refresh fails the session is cleared and the app
 * returns to the sign-in page.
 */
async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    let response = await request(path, options, useStore.getState().tokens?.idToken)
    if (response.status === 401 && (await refreshSession())) {
      response = await request(path, options, useStore.getState().tokens?.idToken)
    }
    if (response.status === 401) {
      useStore.getState().clearAuth()
      return { success: false, error: { code: '401', message: 'Session expired' } }
    }
    return toApiResponse<T>(response)
  } catch {
    return { success: false, error: { code: 'NETWORK_ERROR', message: 'Could not reach the server' } }
  }
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

export const authApi = {
  login: (email: string, password: string) => apiFetch<AuthSession>('/auth/login', post({ email, password })),
  register: (email: string, password: string) => apiFetch<AuthSession>('/auth/register', post({ email, password })),
}

export const searchApi = {
  submitSearch: (criteria: SearchCriteria) => apiFetch<SearchJob>('/search', post(criteria)),
  getSearchResults: (jobId: string, page = 1, pageSize = 100) =>
    apiFetch<PaginatedResponse<SearchResult>>(`/search/${jobId}/results?page=${page}&pageSize=${pageSize}`),
}

const parcelPath = (id: string, sub = '', refresh = false) =>
  `/parcels/${id}${sub ? `/${sub}` : ''}${refresh ? '?refresh=true' : ''}`

export const parcelApi = {
  lookupParcel: (q: string) => apiFetch<Parcel | ParcelCandidates>(`/parcels/lookup?q=${encodeURIComponent(q)}`),
  getParcel: (id: string) => apiFetch<Parcel>(parcelPath(id)),
  getWaterRights: (id: string) => apiFetch<WaterRight[]>(parcelPath(id, 'water-rights')),
  getInsights: (id: string) => apiFetch<ParcelInsight[]>(parcelPath(id, 'insights')),
  getHuntingDistricts: (id: string) => apiFetch<HuntingDistrict[]>(parcelPath(id, 'hunting-districts')),
  getStreamGauges: (id: string) => apiFetch<StreamGauge[]>(parcelPath(id, 'stream-gauges')),
  getRoadAccess: (id: string) => apiFetch<RoadAccess>(parcelPath(id, 'road-access')),
  getUtilities: (id: string) => apiFetch<UtilityAccess>(parcelPath(id, 'utilities')),
  getEnvironmentalRisk: (id: string) => apiFetch<EnvironmentalRisk>(parcelPath(id, 'environmental-risk')),
  getConservationEasements: (id: string) => apiFetch<ConservationEasements>(parcelPath(id, 'conservation-easements')),
  getSoil: (id: string) => apiFetch<SoilInfo>(parcelPath(id, 'soil')),
  getGroundwater: (id: string) => apiFetch<GroundwaterInfo>(parcelPath(id, 'groundwater')),
  checkListingStatus: (id: string, refresh = false) => apiFetch<ListingStatus>(parcelPath(id, 'listing-status', refresh)),
}

// Aurora pauses after 10 idle minutes and takes about 20 seconds to resume.
// Calling this on load moves that wait off the user's first search.
export const warmupApi = {
  wakeDatabase: () => apiFetch<{ ready: boolean; resumeMs: number }>('/warmup'),
}

export const userApi = {
  getSavedParcels: () => apiFetch<SavedParcel[]>('/user/saved'),
  saveParcel: (parcelId: string, notes?: string) => apiFetch<SavedParcel>(`/user/saved/${parcelId}`, post({ notes })),
  removeSavedParcel: (parcelId: string) => apiFetch<void>(`/user/saved/${parcelId}`, { method: 'DELETE' }),
}

/** Unwraps a successful response or throws its error message, for use with react-query. */
export function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.success || response.data === undefined) throw new Error(response.error?.message ?? 'Request failed')
  return response.data
}
