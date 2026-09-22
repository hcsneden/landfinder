import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AuthSession, AuthTokens, BBox, GeoJSONPolygon, Parcel, ParcelCandidate, SearchResult, User } from '@lastbestland/shared'

const MAX_RECENT_SEARCHES = 8

export interface Preferences {
  acreageMin: number | null
  acreageMax: number | null
  waterRights: boolean
  streamAccess: boolean
  maintainedRoad: boolean
  huntingAccess: boolean
  electricGrid: boolean
  lowFloodRisk: boolean
  lowWildfireRisk: boolean
  noMineSites: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  acreageMin: null,
  acreageMax: null,
  waterRights: false,
  streamAccess: false,
  maintainedRoad: false,
  huntingAccess: false,
  electricGrid: false,
  lowFloodRisk: false,
  lowWildfireRisk: false,
  noMineSites: false,
}

export function countActivePreferences(preferences: Preferences): number {
  return Object.values(preferences).filter((value) => value !== null && value !== false).length
}

export type PanelTab = 'search' | 'saved'

interface AppState {
  user: User | null
  tokens: AuthTokens | null
  setAuth: (session: AuthSession) => void
  clearAuth: () => void

  searchResults: SearchResult[]
  isSearching: boolean
  searchError: string | null
  lookupCandidates: ParcelCandidate[] | null
  lookupCandidateRoad: string | null
  setSearchResults: (results: SearchResult[]) => void
  setLookedUpParcel: (parcel: Parcel) => void
  setLookupCandidates: (candidates: ParcelCandidate[], road: string) => void
  clearLookupCandidates: () => void
  setSearching: (isSearching: boolean) => void
  setSearchError: (error: string | null) => void

  selectedParcelId: string | null
  setSelectedParcel: (id: string | null) => void
  selectedParcelBoundary: GeoJSONPolygon | null
  setSelectedParcelBoundary: (boundary: GeoJSONPolygon | null) => void
  hoveredParcelId: string | null
  setHoveredParcel: (id: string | null) => void

  recentSearches: string[]
  addRecentSearch: (query: string) => void
  clearRecentSearches: () => void

  panelTab: PanelTab
  setPanelTab: (tab: PanelTab) => void
  isPanelOpen: boolean
  togglePanel: () => void
  isDetailOpen: boolean
  setDetailOpen: (open: boolean) => void

  isDrawMode: boolean
  setDrawMode: (isDrawMode: boolean) => void
  drawnBBox: BBox | null
  setDrawnBBox: (bbox: BBox | null) => void

  activeLayers: string[]
  toggleLayer: (id: string) => void

  preferences: Preferences
  setPreferences: (preferences: Partial<Preferences>) => void
}

const clearedLookup = { lookupCandidates: null, lookupCandidateRoad: null }

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      setAuth: ({ user, tokens }) => set({ user, tokens }),
      clearAuth: () => set({ user: null, tokens: null }),

      searchResults: [],
      isSearching: false,
      searchError: null,
      lookupCandidates: null,
      lookupCandidateRoad: null,
      setSearchResults: (searchResults) => set({ searchResults, isSearching: false, searchError: null }),
      setLookedUpParcel: (parcel) =>
        set({
          searchResults: [{ parcel, hasWaterRights: false, previewInsight: null, listingStatus: null }],
          selectedParcelId: parcel.id,
          isDetailOpen: true,
          isSearching: false,
          searchError: null,
          ...clearedLookup,
        }),
      setLookupCandidates: (lookupCandidates, lookupCandidateRoad) =>
        set({ lookupCandidates, lookupCandidateRoad, isSearching: false, searchError: null }),
      clearLookupCandidates: () => set(clearedLookup),
      setSearching: (isSearching) => set({ isSearching, searchError: null, ...clearedLookup }),
      setSearchError: (searchError) =>
        set({ searchError, isSearching: false, isDetailOpen: false, selectedParcelId: null, ...clearedLookup }),

      selectedParcelId: null,
      setSelectedParcel: (selectedParcelId) => set({ selectedParcelId, isDetailOpen: selectedParcelId !== null }),
      selectedParcelBoundary: null,
      setSelectedParcelBoundary: (selectedParcelBoundary) => set({ selectedParcelBoundary }),
      hoveredParcelId: null,
      setHoveredParcel: (hoveredParcelId) => set({ hoveredParcelId }),

      recentSearches: [],
      addRecentSearch: (query) =>
        set((state) => {
          const trimmed = query.trim()
          if (!trimmed) return state
          const others = state.recentSearches.filter((recent) => recent.toLowerCase() !== trimmed.toLowerCase())
          return { recentSearches: [trimmed, ...others].slice(0, MAX_RECENT_SEARCHES) }
        }),
      clearRecentSearches: () => set({ recentSearches: [] }),

      panelTab: 'search',
      setPanelTab: (panelTab) => set({ panelTab }),
      isPanelOpen: true,
      togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),
      isDetailOpen: false,
      setDetailOpen: (open) => set(open ? { isDetailOpen: true } : { isDetailOpen: false, selectedParcelId: null }),

      isDrawMode: false,
      setDrawMode: (isDrawMode) => set({ isDrawMode }),
      drawnBBox: null,
      setDrawnBBox: (drawnBBox) => set({ drawnBBox, isDrawMode: false }),

      activeLayers: ['parcel-boundary'],
      toggleLayer: (id) =>
        set((state) => ({
          activeLayers: state.activeLayers.includes(id)
            ? state.activeLayers.filter((layerId) => layerId !== id)
            : [...state.activeLayers, id],
        })),

      preferences: DEFAULT_PREFERENCES,
      setPreferences: (preferences) => set((state) => ({ preferences: { ...state.preferences, ...preferences } })),
    }),
    {
      name: 'lastbestland-session',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        preferences: state.preferences,
        activeLayers: state.activeLayers,
        recentSearches: state.recentSearches,
      }),
      // Fills in preference keys added after a session was persisted.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>
        return { ...current, ...saved, preferences: { ...DEFAULT_PREFERENCES, ...saved.preferences } }
      },
    }
  )
)
