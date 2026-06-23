import { useState, useCallback } from 'react'
import { useStore } from '../store'
import { searchApi } from '../services/api'
import { MONTANA_COUNTIES, formatAcreage, formatPrice, getListingSourceLabel } from '@landfinder/shared'
import type { SearchCriteria } from '@landfinder/shared'
import type { WebSearchCriteria } from '../services/api'

export function SearchPanel() {
  const {
    isPanelOpen,
    searchResults,
    isSearching,
    searchError,
    selectedParcelId,
    hoveredParcelId,
    drawnBBox,
    isDrawMode,
    setSearchResults,
    setSearching,
    setSearchError,
    setSelectedParcel,
    setHoveredParcel,
    setDrawMode,
    setDrawnBBox,
  } = useStore()

  const [criteria, setCriteria] = useState<SearchCriteria>({
    state: 'MT',
  })

  const update = useCallback((patch: Partial<SearchCriteria>) => {
    setCriteria((prev) => ({ ...prev, ...patch }))
  }, [])

  async function handleSearch() {
    setSearching(true)

    const payload: WebSearchCriteria = { ...criteria }
    if (drawnBBox) payload.bbox = drawnBBox

    const jobRes = await searchApi.submitSearch(payload)
    if (!jobRes.success || !jobRes.data) {
      setSearchError(jobRes.error?.message ?? 'Search failed')
      return
    }

    const resultsRes = await searchApi.getSearchResults(jobRes.data.id)
    if (!resultsRes.success || !resultsRes.data) {
      setSearchError(resultsRes.error?.message ?? 'Failed to load results')
      return
    }

    setSearchResults(resultsRes.data.items, jobRes.data.id)
  }

  function clearBBox() {
    setDrawnBBox(null)
  }

  return (
    <aside className={`search-panel ${isPanelOpen ? '' : 'closed'}`}>
      {/* ── Header ── */}
      <div className="panel-head">
        <div className="panel-head-title">Search Montana Land</div>
        <div className="search-input-wrap">
          <span className="search-input-icon">⌕</span>
          <input
            type="text"
            className="search-input"
            placeholder="City, county, parcel number…"
            onChange={(e) => {
              // Text search passed as county for now; backend will need full-text search
              const val = e.target.value
              update({ county: val || undefined })
            }}
          />
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="filters-scroll">
        <div className="filter-field">
          <label className="filter-label">County</label>
          <select
            className="filter-input filter-select"
            value={criteria.county ?? ''}
            onChange={(e) => update({ county: e.target.value || undefined })}
          >
            <option value="">All Counties</option>
            {MONTANA_COUNTIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="filter-row">
          <div>
            <label className="filter-label">Min Acres</label>
            <input
              type="number"
              className="filter-input"
              placeholder="e.g. 5"
              min={0}
              value={criteria.minAcreage ?? ''}
              onChange={(e) => update({ minAcreage: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          <div>
            <label className="filter-label">Max Acres</label>
            <input
              type="number"
              className="filter-input"
              placeholder="No max"
              min={0}
              value={criteria.maxAcreage ?? ''}
              onChange={(e) => update({ maxAcreage: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>

        <div className="filter-row">
          <div>
            <label className="filter-label">Min Price</label>
            <input
              type="number"
              className="filter-input"
              placeholder="$0"
              min={0}
              value={criteria.minPrice ?? ''}
              onChange={(e) => update({ minPrice: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
          <div>
            <label className="filter-label">Max Price</label>
            <input
              type="number"
              className="filter-input"
              placeholder="No max"
              min={0}
              value={criteria.maxPrice ?? ''}
              onChange={(e) => update({ maxPrice: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>

        <button
          className={`filter-toggle ${criteria.waterRightsRequired ? 'active' : ''}`}
          onClick={() => update({ waterRightsRequired: !criteria.waterRightsRequired })}
          type="button"
        >
          <span className="filter-toggle-dot" />
          Water Rights on File
        </button>

        {/* Draw area */}
        {drawnBBox ? (
          <button className="draw-btn active" onClick={clearBBox} type="button">
            <span>▭</span>
            Area drawn — click to clear
          </button>
        ) : (
          <button
            className={`draw-btn ${isDrawMode ? 'active' : ''}`}
            onClick={() => setDrawMode(!isDrawMode)}
            type="button"
          >
            <span>▭</span>
            {isDrawMode ? 'Drawing… click + drag on map' : 'Draw area on map'}
          </button>
        )}

        <button
          className="search-btn"
          onClick={handleSearch}
          disabled={isSearching}
          type="button"
        >
          {isSearching
            ? <><span className="spinner" />Searching…</>
            : 'Search Land'}
        </button>

        {searchError && (
          <div className="panel-error">{searchError}</div>
        )}
      </div>

      {/* ── Results ── */}
      {searchResults.length > 0 && (
        <div className="results-head">
          <span className="results-count">
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
          </span>
          {criteria.waterRightsRequired && (
            <span className="badge badge-water" style={{ fontSize: 9 }}>Water Rights Only</span>
          )}
        </div>
      )}

      {searchResults.length > 0 ? (
        <div className="results-list">
          {searchResults.map((result) => {
            const price = result.listing?.price
            const pricePerAcre =
              price && result.parcel.acreage
                ? Math.round(price / result.parcel.acreage)
                : null

            return (
              <div
                key={result.parcel.id}
                className={[
                  'result-card',
                  result.parcel.id === selectedParcelId ? 'selected' : '',
                  result.parcel.id === hoveredParcelId ? 'hovered' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setSelectedParcel(result.parcel.id)}
                onMouseEnter={() => setHoveredParcel(result.parcel.id)}
                onMouseLeave={() => setHoveredParcel(null)}
              >
                <div className="result-top">
                  <div className="result-acres">
                    {formatAcreage(result.parcel.acreage)}
                  </div>
                  {price && (
                    <div className="result-price">{formatPrice(price)}</div>
                  )}
                </div>

                <div className="result-location">
                  {result.parcel.address
                    ?? `${result.parcel.county ?? 'Unknown'} County, MT`}
                </div>

                <div className="result-meta">
                  {result.hasWaterRights
                    ? <span className="badge badge-water">💧 Water Rights</span>
                    : <span className="badge badge-no-water">⚠ No Water Rights</span>}
                  {result.listing?.source && (
                    <span className="badge badge-source">
                      {getListingSourceLabel(result.listing.source)}
                    </span>
                  )}
                  {pricePerAcre && (
                    <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--font-mono)' }}>
                      ${pricePerAcre.toLocaleString()}/ac
                    </span>
                  )}
                </div>

                {result.previewInsight && (
                  <div className="result-insight">{result.previewInsight}</div>
                )}
              </div>
            )
          })}
        </div>
      ) : !isSearching ? (
        <div className="panel-empty">
          <div className="panel-empty-icon">⬡</div>
          <div className="panel-empty-title">No results yet</div>
          <div className="panel-empty-sub">
            Set your filters and search, or draw an area directly on the map.
          </div>
        </div>
      ) : null}
    </aside>
  )
}
