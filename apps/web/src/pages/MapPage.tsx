import { Button } from '@hcsneden/design-library'
import { useStore } from '../store'
import { MapView } from '../components/MapView'
import { SearchPanel } from '../components/SearchPanel'
import { ParcelDetailSheet } from '../components/ParcelDetailSheet'

export function MapPage() {
  const { user, clearAuth, isPanelOpen, togglePanel, isDetailOpen } = useStore()

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
          <Button variant="ghost" size="sm" onClick={clearAuth}>
            Sign out
          </Button>
        </div>
      </header>

      <div className="app-layout">
        <SearchPanel />

        <div className="map-wrap">
          <MapView />
          {isDetailOpen && <ParcelDetailSheet />}
        </div>
      </div>
    </>
  )
}
