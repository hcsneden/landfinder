import { useEffect, useRef, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useStore } from '../store'
import { formatPrice } from '@lastbestland/shared'
import type { SearchResult } from '@lastbestland/shared'
import { searchApi } from '../services/api'

// CARTO Voyager — free, no API key required
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'

const WMS_RASTER_LAYERS = [
  {
    id: 'fema-flood',
    sourceId: 'fema-flood-src',
    tiles: ['https://hazards.fema.gov/gis/nfhl/services/public/NFHL/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&LAYERS=28&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.1.1&SRS=EPSG%3A3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256'],
  },
  {
    id: 'nwi-wetlands',
    sourceId: 'nwi-wetlands-src',
    tiles: ['https://www.fws.gov/wetlands/arcgis/services/Wetlands/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&LAYERS=1&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.1.1&SRS=EPSG%3A3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256'],
  },
  {
    id: 'public-land',
    sourceId: 'public-land-src',
    tiles: ['https://gis.blm.gov/arcgis/services/lands/BLM_National_Surface_Agency_Land_Status_and_Case_Designation_Layers/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetMap&LAYERS=1&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true&VERSION=1.1.1&SRS=EPSG%3A3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256'],
  },
]

const MAX_POLL_ATTEMPTS = 10
const FIRST_POLL_DELAY_MS = 1200
const POLL_INTERVAL_MS = 1500

const TOGGLEABLE_LAYERS = [
  { id: 'parcel-boundary', label: 'Parcel Boundary' },
  { id: 'fema-flood', label: 'FEMA Flood Zones' },
  { id: 'nwi-wetlands', label: 'NWI Wetlands' },
  { id: 'public-land', label: 'BLM / Public Land' },
]

function formatCompactPrice(price: number): string {
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1)}M`
  if (price >= 1_000) return `$${Math.round(price / 1_000)}K`
  return formatPrice(price)
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<{ marker: maplibregl.Marker; element: HTMLElement; parcelId: string }[]>([])

  const drawStartRef = useRef<maplibregl.LngLat | null>(null)
  const drawStartPointRef = useRef<maplibregl.Point | null>(null)
  const drawBoxElementRef = useRef<HTMLDivElement | null>(null)

  const { searchResults, selectedParcelId, hoveredParcelId, isDrawMode, drawnBBox, preferences, selectedParcelBoundary, activeLayers } =
    useStore(
      useShallow((state) => ({
        searchResults: state.searchResults,
        selectedParcelId: state.selectedParcelId,
        hoveredParcelId: state.hoveredParcelId,
        isDrawMode: state.isDrawMode,
        drawnBBox: state.drawnBBox,
        preferences: state.preferences,
        selectedParcelBoundary: state.selectedParcelBoundary,
        activeLayers: state.activeLayers,
      }))
    )

  const { setDrawMode, setDrawnBBox, setSearchResults, setSearching, toggleLayer } = useStore(
    useShallow((state) => ({
      setDrawMode: state.setDrawMode,
      setDrawnBBox: state.setDrawnBBox,
      setSearchResults: state.setSearchResults,
      setSearching: state.setSearching,
      toggleLayer: state.toggleLayer,
    }))
  )

  const [isLayerPanelOpen, setIsLayerPanelOpen] = useState(false)
  const [isBboxSearching, setIsBboxSearching] = useState(false)
  const [styleLoaded, setStyleLoaded] = useState(false)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initialize map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-109.5, 46.9],
      zoom: 6,
      attributionControl: false,
    })

    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right'
    )
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left')

    mapRef.current = map

    if (map.isStyleLoaded()) setStyleLoaded(true)
    else map.once('load', () => setStyleLoaded(true))

    return () => {
      map.remove()
      mapRef.current = null
      setStyleLoaded(false)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleLoaded) return

    for (const wmsLayer of WMS_RASTER_LAYERS) {
      if (map.getSource(wmsLayer.sourceId)) continue
      map.addSource(wmsLayer.sourceId, { type: 'raster', tiles: wmsLayer.tiles, tileSize: 256 })
      map.addLayer({
        id: wmsLayer.id,
        type: 'raster',
        source: wmsLayer.sourceId,
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.65 },
      })
    }
  }, [styleLoaded])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleLoaded) return
    for (const wmsLayer of WMS_RASTER_LAYERS) {
      if (map.getLayer(wmsLayer.id)) {
        map.setLayoutProperty(wmsLayer.id, 'visibility', activeLayers.includes(wmsLayer.id) ? 'visible' : 'none')
      }
    }
  }, [styleLoaded, activeLayers])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !styleLoaded) return

    const removeExistingBoundaryLayers = () => {
      if (map.getLayer('parcel-outline')) map.removeLayer('parcel-outline')
      if (map.getLayer('parcel-fill')) map.removeLayer('parcel-fill')
      if (map.getSource('parcel-boundary-src')) map.removeSource('parcel-boundary-src')
    }

    removeExistingBoundaryLayers()

    if (!selectedParcelBoundary || !activeLayers.includes('parcel-boundary')) return

    map.addSource('parcel-boundary-src', { type: 'geojson', data: selectedParcelBoundary as unknown as GeoJSON.GeoJSON })
    map.addLayer({ id: 'parcel-fill', type: 'fill', source: 'parcel-boundary-src', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 } })
    map.addLayer({ id: 'parcel-outline', type: 'line', source: 'parcel-boundary-src', paint: { 'line-color': '#f59e0b', 'line-width': 2.5 } })
  }, [styleLoaded, selectedParcelBoundary, activeLayers])

  const hasAnyPreferenceSet =
    preferences.acreageMin !== null || preferences.acreageMax !== null ||
    preferences.waterRights || preferences.streamAccess || preferences.maintainedRoad ||
    preferences.huntingAccess || preferences.electricGrid || preferences.broadband ||
    preferences.lowFloodRisk || preferences.lowWildfireRisk || preferences.noMineSites

  function getMarkerScoreClass(result: SearchResult): string {
    if (!hasAnyPreferenceSet) return result.hasWaterRights ? 'has-water' : 'no-water'

    let criteriaMet = 0
    let criteriaChecked = 0
    const { acreage } = result.parcel

    if (preferences.acreageMin !== null || preferences.acreageMax !== null) {
      criteriaChecked++
      const meetsMinimum = preferences.acreageMin === null || (acreage !== null && acreage >= preferences.acreageMin)
      const meetsMaximum = preferences.acreageMax === null || (acreage !== null && acreage <= preferences.acreageMax)
      if (meetsMinimum && meetsMaximum) criteriaMet++
    }
    if (preferences.waterRights) {
      criteriaChecked++
      if (result.hasWaterRights) criteriaMet++
    }

    if (criteriaChecked === 0) return 'score-unknown'
    const fractionMet = criteriaMet / criteriaChecked
    if (fractionMet === 1) return 'score-excellent'
    if (fractionMet >= 0.67) return 'score-good'
    if (fractionMet >= 0.34) return 'score-partial'
    return 'score-poor'
  }

  // Selected/hovered styling is applied by the effect below rather than here, so that
  // hovering a marker never rebuilds the DOM or re-fits the map bounds.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    markersRef.current.forEach(({ marker }) => marker.remove())
    markersRef.current = []

    if (searchResults.length === 0) return

    const bounds = new maplibregl.LngLatBounds()
    let foundAnyCoordinates = false

    searchResults.forEach((result) => {
      const coordinates = result.parcel.coordinates
      if (!coordinates) return

      const { longitude, latitude } = coordinates
      foundAnyCoordinates = true

      // No listing feed, so the price on the pin usually comes from the per-parcel
      // for-sale check rather than from a listing row.
      const price = result.listing?.price ?? result.listingStatus?.price ?? null
      const isForSale = result.listingStatus?.forSale ?? false

      const markerElement = document.createElement('div')
      markerElement.className = 'map-marker'

      const pinElement = document.createElement('div')
      pinElement.className = `marker-pin ${getMarkerScoreClass(result)}${isForSale ? ' for-sale' : ''}`
      pinElement.textContent = price ? formatCompactPrice(price) : isForSale ? 'For sale' : '—'
      if (isForSale) {
        pinElement.title = result.listingStatus?.source
          ? `Listed on ${result.listingStatus.source}`
          : 'Listed for sale'
      }

      const stemElement = document.createElement('div')
      stemElement.className = 'marker-stem'
      markerElement.append(pinElement, stemElement)

      markerElement.addEventListener('mouseenter', () => useStore.getState().setHoveredParcel(result.parcel.id))
      markerElement.addEventListener('mouseleave', () => useStore.getState().setHoveredParcel(null))
      markerElement.addEventListener('click', (clickEvent) => {
        clickEvent.stopPropagation()
        useStore.getState().setSelectedParcel(result.parcel.id)
      })

      const marker = new maplibregl.Marker({ element: markerElement, anchor: 'bottom' })
        .setLngLat([longitude, latitude])
        .addTo(map)

      markersRef.current.push({ marker, element: markerElement, parcelId: result.parcel.id })
      bounds.extend([longitude, latitude])
    })

    if (foundAnyCoordinates) {
      map.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 600 })
    }
  }, [searchResults, preferences, hasAnyPreferenceSet])

  // Declared after the effect above so a freshly built marker set is styled in the same commit.
  useEffect(() => {
    for (const { element, parcelId } of markersRef.current) {
      element.classList.toggle('selected', parcelId === selectedParcelId)
      element.classList.toggle('hovered', parcelId === hoveredParcelId)
    }
  }, [searchResults, selectedParcelId, hoveredParcelId])

  // Fly to selected parcel
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedParcelId) return

    const result = searchResults.find((result) => result.parcel.id === selectedParcelId)
    if (!result?.parcel.coordinates) return

    map.flyTo({
      center: [result.parcel.coordinates.longitude, result.parcel.coordinates.latitude],
      zoom: Math.max(map.getZoom(), 12),
      duration: 500,
    })
  }, [selectedParcelId, searchResults])

  // ── Draw mode ──────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (mouseEvent: maplibregl.MapMouseEvent) => {
      if (!isDrawMode) return
      mouseEvent.preventDefault()
      drawStartRef.current = mouseEvent.lngLat
      drawStartPointRef.current = mouseEvent.point

      const boxElement = document.createElement('div')
      boxElement.style.cssText = `
        position: absolute; pointer-events: none; z-index: 10;
        border: 2px dashed #1e4d2b; background: rgba(30,77,43,0.07);
        left: ${mouseEvent.point.x}px; top: ${mouseEvent.point.y}px; width: 0; height: 0;
      `
      containerRef.current?.appendChild(boxElement)
      drawBoxElementRef.current = boxElement
    },
    [isDrawMode]
  )

  const handleMouseMove = useCallback(
    (mouseEvent: maplibregl.MapMouseEvent) => {
      if (!isDrawMode || !drawStartPointRef.current || !drawBoxElementRef.current) return
      const startPoint = drawStartPointRef.current
      const currentPoint = mouseEvent.point
      drawBoxElementRef.current.style.left   = `${Math.min(startPoint.x, currentPoint.x)}px`
      drawBoxElementRef.current.style.top    = `${Math.min(startPoint.y, currentPoint.y)}px`
      drawBoxElementRef.current.style.width  = `${Math.abs(currentPoint.x - startPoint.x)}px`
      drawBoxElementRef.current.style.height = `${Math.abs(currentPoint.y - startPoint.y)}px`
    },
    [isDrawMode]
  )

  const handleMouseUp = useCallback(
    (mouseEvent: maplibregl.MapMouseEvent) => {
      if (!isDrawMode || !drawStartRef.current) return

      drawBoxElementRef.current?.remove()
      drawBoxElementRef.current = null

      const startLngLat = drawStartRef.current
      const endLngLat = mouseEvent.lngLat
      drawStartRef.current = null
      drawStartPointRef.current = null

      setDrawnBBox({
        minLng: Math.min(startLngLat.lng, endLngLat.lng),
        minLat: Math.min(startLngLat.lat, endLngLat.lat),
        maxLng: Math.max(startLngLat.lng, endLngLat.lng),
        maxLat: Math.max(startLngLat.lat, endLngLat.lat),
      })
      setDrawMode(false)
    },
    [isDrawMode, setDrawnBBox, setDrawMode]
  )

  const handleBboxSearch = useCallback(async () => {
    if (!drawnBBox || isBboxSearching) return
    setIsBboxSearching(true)
    setSearching(true)

    const stopSearching = () => {
      setIsBboxSearching(false)
      setSearching(false)
    }

    const submitResponse = await searchApi.submitSearch({ state: 'MT', bbox: drawnBBox })
    if (!submitResponse.success || !submitResponse.data) {
      stopSearching()
      return
    }

    const jobId = submitResponse.data.id
    let pollAttempts = 0

    const pollForResults = async () => {
      pollAttempts++
      if (pollAttempts > MAX_POLL_ATTEMPTS) {
        stopSearching()
        return
      }
      const resultsResponse = await searchApi.getSearchResults(jobId)
      if (resultsResponse.success && resultsResponse.data) {
        setSearchResults(resultsResponse.data.items, jobId)
        stopSearching()
      } else {
        pollTimeoutRef.current = setTimeout(pollForResults, POLL_INTERVAL_MS)
      }
    }
    pollTimeoutRef.current = setTimeout(pollForResults, FIRST_POLL_DELAY_MS)
  }, [drawnBBox, isBboxSearching, setSearchResults, setSearching])

  useEffect(() => {
    return () => { if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current) }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (isDrawMode) {
      map.getCanvas().style.cursor = 'crosshair'
      map.dragPan.disable()
      map.on('mousedown', handleMouseDown)
      map.on('mousemove', handleMouseMove)
      map.on('mouseup', handleMouseUp)
    } else {
      map.getCanvas().style.cursor = ''
      map.dragPan.enable()
      map.off('mousedown', handleMouseDown)
      map.off('mousemove', handleMouseMove)
      map.off('mouseup', handleMouseUp)
    }

    return () => {
      map.off('mousedown', handleMouseDown)
      map.off('mousemove', handleMouseMove)
      map.off('mouseup', handleMouseUp)
    }
  }, [isDrawMode, handleMouseDown, handleMouseMove, handleMouseUp])

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      <div className="layer-panel-wrap">
        <button
          className={`layer-panel-btn ${isLayerPanelOpen ? 'active' : ''}`}
          onClick={() => setIsLayerPanelOpen((isOpen) => !isOpen)}
          title="Map layers"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="12" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="7.25" width="12" height="1.5" rx="0.75" fill="currentColor" />
            <rect x="2" y="11.5" width="12" height="1.5" rx="0.75" fill="currentColor" />
          </svg>
          Layers
        </button>
        {isLayerPanelOpen && (
          <div className="layer-panel">
            <div className="layer-panel-title">Map Layers</div>
            {TOGGLEABLE_LAYERS.map((layer) => (
              <label key={layer.id} className="layer-toggle-row">
                <input
                  type="checkbox"
                  checked={activeLayers.includes(layer.id)}
                  onChange={() => toggleLayer(layer.id)}
                />
                <span>{layer.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {drawnBBox && (
        <div className="bbox-search-wrap">
          <button
            className="bbox-search-btn"
            onClick={handleBboxSearch}
            disabled={isBboxSearching}
          >
            {isBboxSearching ? (
              <><span className="spinner spinner-sm" /> Searching…</>
            ) : (
              'Search this area'
            )}
          </button>
          <button
            className="bbox-clear-btn"
            onClick={() => setDrawnBBox(null)}
            title="Clear drawn area"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
