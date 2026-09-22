import { useState, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button, Input } from '@hcsneden/design-library'
import { useStore, DEFAULT_PREFERENCES, countActivePreferences } from '../store'
import type { Preferences } from '../store'
import { parcelApi, warmupApi } from '../services/api'
import { formatAcreage } from '@lastbestland/shared'
import type { ParcelCandidate } from '@lastbestland/shared'
import { SavedPanel } from './SavedPanel'

const LOOKUP_STATUS_LABELS = [
  'Searching Montana cadastral records…',
  'Verifying parcel location…',
  'Fetching water rights from DNRC…',
  'This is taking a moment…',
]

// Elapsed milliseconds at which each label after the first takes over.
const LOOKUP_STATUS_ELAPSED_MS = [1800, 4300, 8300]

// A candidate matches a typed acreage/price if it is within 20% of it.
const CANDIDATE_MATCH_TOLERANCE = 0.2

const ASSESSED_VALUE_FORMAT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const NOT_FOUND_MESSAGE =
  "We couldn't find that parcel. Double-check the address or parcel number, or try just the street name " +
  '(for example "Coyote Dr"). If a few parcels share it, you can narrow them down with details from the listing ' +
  '(acreage, price, subdivision name).'


/**
 * Starts an Aurora resume on the first sign that a visitor is about to search.
 *
 * Deliberately not on page load: most parcel reads are served from the DynamoDB
 * cache and never touch Aurora, so waking it for every visitor would keep a
 * cluster running that should be asleep. Focusing the search box is the earliest
 * honest signal that a query is coming. Once per page, fire and forget, since a
 * failure costs nothing and the query retries on its own.
 */
let databaseWakeRequested = false
function wakeDatabaseOnce() {
  if (databaseWakeRequested) return
  databaseWakeRequested = true
  void warmupApi.wakeDatabase()
}

export function SearchPanel() {
  const { isPanelOpen, isSearching, searchError, lookupCandidates, lookupCandidateRoad, preferences, recentSearches, panelTab } =
    useStore(
      useShallow((state) => ({
        isPanelOpen: state.isPanelOpen,
        isSearching: state.isSearching,
        searchError: state.searchError,
        lookupCandidates: state.lookupCandidates,
        lookupCandidateRoad: state.lookupCandidateRoad,
        preferences: state.preferences,
        recentSearches: state.recentSearches,
        panelTab: state.panelTab,
      }))
    )

  const {
    setSearching, setSearchError, setLookedUpParcel, setLookupCandidates,
    clearLookupCandidates, setPreferences, addRecentSearch, clearRecentSearches, setPanelTab,
  } = useStore(
    useShallow((state) => ({
      setSearching: state.setSearching,
      setSearchError: state.setSearchError,
      setLookedUpParcel: state.setLookedUpParcel,
      setLookupCandidates: state.setLookupCandidates,
      clearLookupCandidates: state.clearLookupCandidates,
      setPreferences: state.setPreferences,
      addRecentSearch: state.addRecentSearch,
      clearRecentSearches: state.clearRecentSearches,
      setPanelTab: state.setPanelTab,
    }))
  )
  const [query, setQuery] = useState('')
  const [acreageFilter, setAcreageFilter] = useState('')
  const [priceFilter, setPriceFilter] = useState('')
  const [subdivisionFilter, setSubdivisionFilter] = useState('')
  const [statusIndex, setStatusIndex] = useState(0)
  const [isRecentDropdownOpen, setIsRecentDropdownOpen] = useState(false)
  const searchBoxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setStatusIndex(0)
    if (!isSearching) return

    const timers = LOOKUP_STATUS_ELAPSED_MS.map((elapsedMs, statusOffset) =>
      setTimeout(() => setStatusIndex(statusOffset + 1), elapsedMs)
    )
    return () => timers.forEach(clearTimeout)
  }, [isSearching])

  useEffect(() => {
    if (!isRecentDropdownOpen) return
    function closeDropdownOnOutsideClick(mouseEvent: MouseEvent) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(mouseEvent.target as Node)) {
        setIsRecentDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', closeDropdownOnOutsideClick)
    return () => window.removeEventListener('mousedown', closeDropdownOnOutsideClick)
  }, [isRecentDropdownOpen])

  async function handleLookup(submitEvent?: React.FormEvent, queryOverride?: string) {
    submitEvent?.preventDefault()
    const searchTerm = (queryOverride ?? query).trim()
    if (!searchTerm) return

    setIsRecentDropdownOpen(false)
    addRecentSearch(searchTerm)
    setSearching(true)
    const response = await parcelApi.lookupParcel(searchTerm)

    if (!response.success) {
      setSearchError(response.error?.message ?? 'Lookup failed')
      return
    }
    if (!response.data) {
      setSearchError(NOT_FOUND_MESSAGE)
      return
    }
    if ('candidates' in response.data) {
      setLookupCandidates(response.data.candidates, response.data.roadName)
      return
    }
    setLookedUpParcel(response.data)
  }

  async function handleCandidateSelect(candidate: ParcelCandidate) {
    setSearching(true)
    const response = await parcelApi.lookupParcel(candidate.parcelId)
    if (!response.success) {
      setSearchError(response.error?.message ?? 'Lookup failed')
      return
    }
    if (!response.data || 'candidates' in response.data) {
      setSearchError('Could not load that parcel. Try again.')
      return
    }
    setLookedUpParcel(response.data)
  }

  function handleRecentSelect(recentQuery: string) {
    setQuery(recentQuery)
    handleLookup(undefined, recentQuery)
  }

  function togglePreference(key: keyof Omit<Preferences, 'acreageMin' | 'acreageMax'>) {
    setPreferences({ [key]: !preferences[key] })
  }

  const activePreferenceCount = countActivePreferences(preferences)

  return (
    <>
    {isSearching && (
      <div className="lookup-overlay">
        <div className="lookup-overlay-card">
          <div className="lookup-overlay-spinner">
            <div className="lookup-spinner-ring" />
          </div>
          <div className="lookup-overlay-status">
            {LOOKUP_STATUS_LABELS[statusIndex]}
          </div>
        </div>
      </div>
    )}
    <aside className={`search-panel ${isPanelOpen ? '' : 'closed'}`}>
      <div className="panel-head">
        <div className="panel-tabs">
          <button
            type="button"
            className={`panel-tab ${panelTab === 'search' ? 'panel-tab-active' : ''}`}
            onClick={() => setPanelTab('search')}
          >
            Search
          </button>
          <button
            type="button"
            className={`panel-tab ${panelTab === 'saved' ? 'panel-tab-active' : ''}`}
            onClick={() => setPanelTab('saved')}
          >
            Saved
          </button>
        </div>
        {panelTab === 'search' && (
          <div className="search-box" ref={searchBoxRef}>
            <form onSubmit={handleLookup}>
              <Input
                type="text"
                placeholder="Address, parcel number, or geocode…"
                value={query}
                onChange={(changeEvent: React.ChangeEvent<HTMLInputElement>) => setQuery(changeEvent.target.value)}
                onFocus={() => {
                  setIsRecentDropdownOpen(true)
                  wakeDatabaseOnce()
                }}
                disabled={isSearching}
              />
            </form>
            {isRecentDropdownOpen && !query.trim() && recentSearches.length > 0 && (
              <div className="recent-dropdown">
                <div className="recent-header">
                  <span className="recent-header-title">Recent searches</span>
                  <button
                    type="button"
                    className="recent-clear"
                    onMouseDown={(mouseEvent) => { mouseEvent.preventDefault(); clearRecentSearches() }}
                  >
                    Clear
                  </button>
                </div>
                {recentSearches.map((recentQuery) => (
                  <button
                    key={recentQuery}
                    type="button"
                    className="recent-item"
                    onMouseDown={(mouseEvent) => { mouseEvent.preventDefault(); handleRecentSelect(recentQuery) }}
                  >
                    <span className="recent-item-icon">↻</span>
                    <span className="recent-item-text">{recentQuery}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {panelTab === 'saved' ? (
        <div className="filters-scroll">
          <SavedPanel />
        </div>
      ) : (
      <div className="filters-scroll">
        <div className="search-btn-wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={handleLookup}
            disabled={isSearching || !query.trim()}
            type="button"
          >
            Look up parcel
          </Button>
        </div>

        {searchError && (
          <div className={searchError === NOT_FOUND_MESSAGE ? 'panel-not-found' : 'panel-error'}>
            {searchError}
          </div>
        )}

        {lookupCandidates && (
          <CandidatePicker
            candidates={lookupCandidates}
            roadName={lookupCandidateRoad ?? ''}
            acreageFilter={acreageFilter}
            onAcreageFilter={setAcreageFilter}
            priceFilter={priceFilter}
            onPriceFilter={setPriceFilter}
            subdivisionFilter={subdivisionFilter}
            onSubdivisionFilter={setSubdivisionFilter}
            onSelect={handleCandidateSelect}
            onCancel={() => {
              clearLookupCandidates()
              setAcreageFilter('')
              setPriceFilter('')
              setSubdivisionFilter('')
            }}
          />
        )}

        <div className="pref-panel">
          <div className="pref-panel-header">
            <div>
              <div className="pref-panel-title">Set your criteria</div>
              <div className="pref-panel-sub">Parcels are scored against your selections</div>
            </div>
            {activePreferenceCount > 0 && (
              <button
                className="pref-clear-btn"
                onClick={() => setPreferences(DEFAULT_PREFERENCES)}
              >
                Clear {activePreferenceCount}
              </button>
            )}
          </div>

          <div className="pref-group">
            <div className="pref-group-label">Acreage range</div>
            <div className="pref-acreage-row">
              <AcreageInput
                placeholder="Min"
                value={preferences.acreageMin}
                onChange={(v) => setPreferences({ acreageMin: v })}
              />
              <span className="pref-acreage-dash">to</span>
              <AcreageInput
                placeholder="Max"
                value={preferences.acreageMax}
                onChange={(v) => setPreferences({ acreageMax: v })}
              />
              <span className="pref-acreage-unit">acres</span>
            </div>
          </div>

          <div className="pref-group">
            <div className="pref-group-label">Water</div>
            <div className="pref-pills">
              <PrefPill label="Water rights" active={preferences.waterRights} onClick={() => togglePreference('waterRights')} />
              <PrefPill label="Stream access" active={preferences.streamAccess} onClick={() => togglePreference('streamAccess')} />
            </div>
          </div>

          <div className="pref-group">
            <div className="pref-group-label">Access & recreation</div>
            <div className="pref-pills">
              <PrefPill label="Maintained road" active={preferences.maintainedRoad} onClick={() => togglePreference('maintainedRoad')} />
              <PrefPill label="Hunting" active={preferences.huntingAccess} onClick={() => togglePreference('huntingAccess')} />
            </div>
          </div>

          <div className="pref-group">
            <div className="pref-group-label">Infrastructure</div>
            <div className="pref-pills">
              <PrefPill label="Electric grid" active={preferences.electricGrid} onClick={() => togglePreference('electricGrid')} />
            </div>
          </div>

          <div className="pref-group pref-group-last">
            <div className="pref-group-label">Risk factors</div>
            <div className="pref-pills">
              <PrefPill label="Low flood risk" active={preferences.lowFloodRisk} onClick={() => togglePreference('lowFloodRisk')} />
              <PrefPill label="Low wildfire risk" active={preferences.lowWildfireRisk} onClick={() => togglePreference('lowWildfireRisk')} />
              <PrefPill label="No mine sites" active={preferences.noMineSites} onClick={() => togglePreference('noMineSites')} />
            </div>
          </div>
        </div>
      </div>
      )}
    </aside>
    </>
  )
}

function PrefPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`pref-pill ${active ? 'pref-pill-active' : ''}`} onClick={onClick} type="button">
      {active && <span className="pref-pill-check">✓</span>}
      {label}
    </button>
  )
}

function CandidatePicker({
  candidates,
  roadName,
  acreageFilter,
  onAcreageFilter,
  priceFilter,
  onPriceFilter,
  subdivisionFilter,
  onSubdivisionFilter,
  onSelect,
  onCancel,
}: {
  candidates: ParcelCandidate[]
  roadName: string
  acreageFilter: string
  onAcreageFilter: (value: string) => void
  priceFilter: string
  onPriceFilter: (value: string) => void
  subdivisionFilter: string
  onSubdivisionFilter: (value: string) => void
  onSelect: (candidate: ParcelCandidate) => void
  onCancel: () => void
}) {
  const targetAcreage = acreageFilter !== '' ? parseFloat(acreageFilter) : null
  const targetPrice = priceFilter !== '' ? parseFloat(priceFilter) : null
  const targetSubdivision = subdivisionFilter.trim().toLowerCase()

  const isWithinTolerance = (actual: number, target: number) =>
    Math.abs(actual - target) / target <= CANDIDATE_MATCH_TOLERANCE

  const matchingCandidates = candidates.filter((candidate) => {
    if (targetAcreage != null && !isNaN(targetAcreage)) {
      if (candidate.acreage == null || !isWithinTolerance(candidate.acreage, targetAcreage)) return false
    }
    if (targetPrice != null && !isNaN(targetPrice)) {
      if (candidate.totalValue == null || !isWithinTolerance(candidate.totalValue, targetPrice)) return false
    }
    if (targetSubdivision) {
      if (!candidate.subdivision?.toLowerCase().includes(targetSubdivision)) return false
    }
    return true
  })

  const hasActiveFilter = Boolean(acreageFilter || priceFilter || subdivisionFilter)

  return (
    <div className="candidate-picker">
      <div className="candidate-picker-header">
        <span className="candidate-picker-title">
          {candidates.length} parcels on {roadName}
        </span>
        <button className="candidate-picker-cancel" onClick={onCancel}>✕</button>
      </div>
      <div className="candidate-picker-hint">
        Use details from the listing (acreage, price, subdivision) to narrow it down
      </div>
      <div className="candidate-filter-row">
        <input
          type="number"
          className="pref-acreage-input"
          placeholder="Acres"
          value={acreageFilter}
          min={0}
          onChange={(changeEvent) => onAcreageFilter(changeEvent.target.value)}
        />
        <input
          type="number"
          className="pref-acreage-input"
          placeholder="Listed price"
          value={priceFilter}
          min={0}
          onChange={(changeEvent) => onPriceFilter(changeEvent.target.value)}
        />
        <input
          type="text"
          className="pref-acreage-input"
          placeholder="Subdivision"
          value={subdivisionFilter}
          onChange={(changeEvent) => onSubdivisionFilter(changeEvent.target.value)}
        />
        {hasActiveFilter && (
          <button
            className="pref-clear-btn"
            onClick={() => { onAcreageFilter(''); onPriceFilter(''); onSubdivisionFilter('') }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="candidate-list">
        {matchingCandidates.length === 0 ? (
          <div className="candidate-empty">No parcels match those details</div>
        ) : (
          matchingCandidates.map((candidate) => (
            <button
              key={candidate.parcelId}
              className={`candidate-item ${candidate.forSale ? 'candidate-item-for-sale' : ''}`}
              onClick={() => onSelect(candidate)}
            >
              <span className="candidate-acres">{formatAcreage(candidate.acreage)}</span>
              <span className="candidate-address">
                {candidate.forSale && <span className="candidate-for-sale-badge">For sale</span>}
                {candidate.address ?? candidate.parcelId}
              </span>
              <span className="candidate-parcel-num">
                {candidate.subdivision ? `${candidate.subdivision} · ` : ''}
                {candidate.totalValue != null
                  ? `Assessed ${ASSESSED_VALUE_FORMAT.format(candidate.totalValue)}`
                  : candidate.parcelId}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function AcreageInput({
  placeholder,
  value,
  onChange,
}: {
  placeholder: string
  value: number | null
  onChange: (value: number | null) => void
}) {
  return (
    <input
      type="number"
      className="pref-acreage-input"
      placeholder={placeholder}
      value={value ?? ''}
      min={0}
      onChange={(changeEvent) => {
        const rawValue = changeEvent.target.value
        onChange(rawValue === '' ? null : Math.max(0, Number(rawValue)))
      }}
    />
  )
}
