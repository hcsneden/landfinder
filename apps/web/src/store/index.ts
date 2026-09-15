import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SearchResult, AuthTokens, User, Parcel, ParcelCandidate, GeoJSONPolygon, BBox } from '@landfinder/shared'

export type { BBox } from '@landfinder/shared'

const MAX_RECENT_SEARCHES = 8

export interface Preferences {
  // Size
  acreageMin: number | null
  acreageMax: number | null
  // Water
  waterRights: boolean
  streamAccess: boolean
  // Access & Recreation
  maintainedRoad: boolean
  huntingAccess: boolean
  // Infrastructure
  electricGrid: boolean
  broadband: boolean
  // Risk
  lowFloodRisk: boolean
  lowWildfireRisk: boolean
  noMineSites: boolean
}

interface AppState {
  user: User | null
  tokens: AuthTokens | null
  setAuth: (user: User, tokens: AuthTokens) => void
  clearAuth: () => void

  searchResults: SearchResult[]
  searchJobId: string | null
  isSearching: boolean
  searchError: string | null
  lookupCandidates: ParcelCandidate[] | null
  lookupCandidateRoad: string | null
  setSearchResults: (results: SearchResult[], jobId: string) => void
  setLookedUpParcel: (parcel: Parcel) => void
  setLookupCandidates: (candidates: ParcelCandidate[], road: string) => void
  clearLookupCandidates: () => void
  setSearching: (v: boolean) => void
  setSearchError: (err: string | null) => void
  clearSearch: () => void

  selectedParcelId: string | null
  setSelectedParcel: (id: string | null) => void

  recentSearches: string[]
  addRecentSearch: (q: string) => void
  clearRecentSearches: () => void

  panelTab: 'search' | 'saved'
  setPanelTab: (tab: 'search' | 'saved') => void

  isPanelOpen: boolean
  isDetailOpen: boolean
  isDrawMode: boolean
  drawnBBox: BBox | null
  hoveredParcelId: string | null
  togglePanel: () => void
  setDetailOpen: (open: boolean) => void
  setDrawMode: (v: boolean) => void
  setDrawnBBox: (bbox: BBox | null) => void
  setHoveredParcel: (id: string | null) => void

  selectedParcelBoundary: GeoJSONPolygon | null
  setSelectedParcelBoundary: (boundary: GeoJSONPolygon | null) => void
  activeLayers: string[]
  toggleLayer: (id: string) => void

  preferences: Preferences
  setPreferences: (prefs: Partial<Preferences>) => void
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      setAuth: (user, tokens) => set({ user, tokens }),
      clearAuth: () => set({ user: null, tokens: null }),

      searchResults: [],
      searchJobId: null,
      isSearching: false,
      searchError: null,
      lookupCandidates: null,
      lookupCandidateRoad: null,
      setSearchResults: (results, jobId) =>
        set({ searchResults: results, searchJobId: jobId, isSearching: false, searchError: null }),
      setLookedUpParcel: (parcel) =>
        set({
          searchResults: [{ parcel, listing: null, hasWaterRights: false, previewInsight: null }],
          selectedParcelId: parcel.id,
          isDetailOpen: true,
          isSearching: false,
          searchError: null,
          lookupCandidates: null,
          lookupCandidateRoad: null,
        }),
      setLookupCandidates: (candidates, road) =>
        set({ lookupCandidates: candidates, lookupCandidateRoad: road, isSearching: false, searchError: null }),
      clearLookupCandidates: () =>
        set({ lookupCandidates: null, lookupCandidateRoad: null }),
      setSearching: (v) => set({ isSearching: v, searchError: null, lookupCandidates: null, lookupCandidateRoad: null }),
      setSearchError: (err) => set({ searchError: err, isSearching: false, isDetailOpen: false, selectedParcelId: null, lookupCandidates: null, lookupCandidateRoad: null }),
      clearSearch: () => set({ searchResults: [], searchJobId: null }),

      selectedParcelId: null,
      setSelectedParcel: (id) => set({ selectedParcelId: id, isDetailOpen: id !== null }),

      recentSearches: [],
      addRecentSearch: (query) =>
        set((state) => {
          const trimmedQuery = query.trim()
          if (!trimmedQuery) return state
          const withoutDuplicate = state.recentSearches.filter(
            (recent) => recent.toLowerCase() !== trimmedQuery.toLowerCase()
          )
          return { recentSearches: [trimmedQuery, ...withoutDuplicate].slice(0, MAX_RECENT_SEARCHES) }
        }),
      clearRecentSearches: () => set({ recentSearches: [] }),

      panelTab: 'search',
      setPanelTab: (tab) => set({ panelTab: tab }),

      isPanelOpen: true,
      isDetailOpen: false,
      isDrawMode: false,
      drawnBBox: null,
      hoveredParcelId: null,
      togglePanel: () => set((state) => ({ isPanelOpen: !state.isPanelOpen })),
      setDetailOpen: (open) => set(open ? { isDetailOpen: true } : { isDetailOpen: false, selectedParcelId: null }),
      setDrawMode: (v) => set({ isDrawMode: v }),
      setDrawnBBox: (bbox) => set({ drawnBBox: bbox, isDrawMode: false }),
      setHoveredParcel: (id) => set({ hoveredParcelId: id }),

      selectedParcelBoundary: null,
      setSelectedParcelBoundary: (boundary) => set({ selectedParcelBoundary: boundary }),
      activeLayers: ['parcel-boundary'],
      toggleLayer: (id) => set((state) => ({
        activeLayers: state.activeLayers.includes(id)
          ? state.activeLayers.filter((layerId) => layerId !== id)
          : [...state.activeLayers, id],
      })),

      preferences: {
        acreageMin: null, acreageMax: null,
        waterRights: false, streamAccess: false,
        maintainedRoad: false, huntingAccess: false,
        electricGrid: false, broadband: false,
        lowFloodRisk: false, lowWildfireRisk: false, noMineSites: false,
      },
      setPreferences: (prefs) =>
        set((state) => ({ preferences: { ...state.preferences, ...prefs } })),
    }),
    {
      name: 'landfinder-session',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        preferences: state.preferences,
        activeLayers: state.activeLayers,
        recentSearches: state.recentSearches,
      }),
    }
  )
)
