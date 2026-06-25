import { useState } from 'react'
import { Button, Input, Typography } from '@hcsneden/design-library'
import { useStore } from '../store'
import { parcelApi } from '../services/api'

export function SearchPanel() {
  const { isPanelOpen, isSearching, searchError, setSearching, setSearchError, setLookedUpParcel } = useStore()
  const [query, setQuery] = useState('')

  async function handleLookup(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return

    setSearching(true)
    const res = await parcelApi.lookupParcel(q)

    if (!res.success) {
      setSearchError(res.error?.message ?? 'Lookup failed')
      return
    }
    if (!res.data) {
      setSearchError('No parcel found. Try a street address, parcel number, or geocode.')
      return
    }

    setLookedUpParcel(res.data)
  }

  return (
    <aside className={`search-panel ${isPanelOpen ? '' : 'closed'}`}>
      <div className="panel-head">
        <div className="panel-head-title">Search Montana Land</div>
        <form onSubmit={handleLookup}>
          <Input
            type="text"
            placeholder="Address, parcel number, or geocode…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={isSearching}
          />
        </form>
      </div>

      <div className="filters-scroll">
        <div className="search-btn-wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={handleLookup}
            disabled={isSearching || !query.trim()}
            type="button"
          >
            {isSearching
              ? <><span className="spinner" />Looking up…</>
              : 'Look up parcel'}
          </Button>
        </div>

        {searchError && (
          <div className="panel-error">{searchError}</div>
        )}

        {!isSearching && !searchError && (
          <div className="panel-empty">
            <div className="panel-empty-icon">⬡</div>
            <Typography variant="h4" as="p" className="panel-empty-title">
              Enter a Montana parcel
            </Typography>
            <Typography variant="body-sm" muted className="panel-empty-sub">
              Search by street address, parcel number, or geocode to pull property details and water rights.
            </Typography>
          </div>
        )}
      </div>
    </aside>
  )
}
