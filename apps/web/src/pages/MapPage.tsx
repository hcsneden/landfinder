import { useStore } from '../store'
import { MapView } from '../components/MapView'
import { SearchPanel } from '../components/SearchPanel'
import { ParcelDetailSheet } from '../components/ParcelDetailSheet'
import type { BBox } from '../store'

export function MapPage() {
  const { user, clearAuth, isPanelOpen, togglePanel, isDetailOpen, isDrawMode } = useStore()

  function handleDrawComplete(bbox: BBox) {
    useStore.getState().setDrawnBBox(bbox)
  }

  return (
    <>
      <header className="header">
        <button className="panel-toggle-btn" onClick={togglePanel} title="Toggle search panel">
          <span style={{ transform: isPanelOpen ? 'none' : 'rotate(-45deg) translateY(3px)' }} />
          <span style={{ opacity: isPanelOpen ? 1 : 0 }} />
          <span style={{ transform: isPanelOpen ? 'none' : 'rotate(45deg) translateY(-3px)' }} />
        </button>
        <div className="header-logo">Land<span>Finder</span></div>
        <div className="header-actions">
          {user && <span className="header-user">{user.email}</span>}
          <button className="header-btn header-btn-ghost" onClick={clearAuth}>
            Sign out
          </button>
        </div>
      </header>

      <div className="app-layout">
        <SearchPanel />

        <div className="map-wrap">
          <MapView onDrawComplete={handleDrawComplete} />
          {isDetailOpen && <ParcelDetailSheet />}
          {isDrawMode && (
            <div className="draw-hint">
              Click and drag to draw a search area — release to search
            </div>
          )}
        </div>
      </div>
    </>
  )
}
