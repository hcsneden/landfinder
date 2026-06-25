import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SearchResult, AuthTokens, User, Parcel } from '@landfinder/shared'

export interface BBox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
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
  setSearchResults: (results: SearchResult[], jobId: string) => void
  setLookedUpParcel: (parcel: Parcel) => void
  setSearching: (v: boolean) => void
  setSearchError: (err: string | null) => void
  clearSearch: () => void

  selectedParcelId: string | null
  setSelectedParcel: (id: string | null) => void

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
      setSearchResults: (results, jobId) =>
        set({ searchResults: results, searchJobId: jobId, isSearching: false, searchError: null }),
      setLookedUpParcel: (parcel) =>
        set({
          searchResults: [{ parcel, listing: null, hasWaterRights: false, previewInsight: null }],
          selectedParcelId: parcel.id,
          isDetailOpen: true,
          isSearching: false,
          searchError: null,
        }),
      setSearching: (v) => set({ isSearching: v, searchError: null }),
      setSearchError: (err) => set({ searchError: err, isSearching: false }),
      clearSearch: () => set({ searchResults: [], searchJobId: null }),

      selectedParcelId: null,
      setSelectedParcel: (id) => set({ selectedParcelId: id, isDetailOpen: id !== null }),

      isPanelOpen: true,
      isDetailOpen: false,
      isDrawMode: false,
      drawnBBox: null,
      hoveredParcelId: null,
      togglePanel: () => set((s) => ({ isPanelOpen: !s.isPanelOpen })),
      setDetailOpen: (open) => set({ isDetailOpen: open, selectedParcelId: open ? undefined : null }),
      setDrawMode: (v) => set({ isDrawMode: v }),
      setDrawnBBox: (bbox) => set({ drawnBBox: bbox, isDrawMode: false }),
      setHoveredParcel: (id) => set({ hoveredParcelId: id }),
    }),
    {
      name: 'landfinder-session',
      partialize: (s) => ({ user: s.user, tokens: s.tokens }),
    }
  )
)
