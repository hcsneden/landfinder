import { useEffect, useRef, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useStore } from '../store'
import type { BBox } from '../store'
import { formatPrice } from '@landfinder/shared'

// CARTO Voyager — free, no API key required
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'

function formatCompactPrice(price: number): string {
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1)}M`
  if (price >= 1_000) return `$${Math.round(price / 1_000)}K`
  return formatPrice(price)
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<{ marker: maplibregl.Marker; el: HTMLElement; id: string }[]>([])

  const drawStartRef = useRef<maplibregl.LngLat | null>(null)
  const drawStartPointRef = useRef<maplibregl.Point | null>(null)
  const drawBoxElRef = useRef<HTMLDivElement | null>(null)

  const {
    searchResults,
    selectedParcelId,
    hoveredParcelId,
    isDrawMode,
    setSelectedParcel,
    setHoveredParcel,
    setDrawMode,
    setDrawnBBox,
  } = useStore()

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

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Sync markers whenever results, selected, or hovered changes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Remove old markers
    markersRef.current.forEach(({ marker }) => marker.remove())
    markersRef.current = []

    if (searchResults.length === 0) return

    const bounds = new maplibregl.LngLatBounds()
    let hasCoords = false

    searchResults.forEach((result) => {
      const coords = result.parcel.coordinates
      if (!coords) return

      const { longitude, latitude } = coords
      hasCoords = true

      const price = result.listing?.price
      const isSelected = result.parcel.id === selectedParcelId
      const isHovered = result.parcel.id === hoveredParcelId

      const el = document.createElement('div')
      el.className = [
        'map-marker',
        isSelected ? 'selected' : '',
        isHovered ? 'hovered' : '',
      ].filter(Boolean).join(' ')

      el.innerHTML = `
        <div class="marker-pin ${result.hasWaterRights ? 'has-water' : 'no-water'}">
          ${price ? formatCompactPrice(price) : '—'}
        </div>
        <div class="marker-stem"></div>
      `

      el.addEventListener('mouseenter', () => setHoveredParcel(result.parcel.id))
      el.addEventListener('mouseleave', () => setHoveredParcel(null))
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        setSelectedParcel(result.parcel.id)
      })

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([longitude, latitude])
        .addTo(map)

      markersRef.current.push({ marker, el, id: result.parcel.id })
      bounds.extend([longitude, latitude])
    })

    if (hasCoords) {
      map.fitBounds(bounds, { padding: 80, maxZoom: 13, duration: 600 })
    }
  }, [searchResults, selectedParcelId, hoveredParcelId, setSelectedParcel, setHoveredParcel])

  // Fly to selected parcel
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedParcelId) return

    const result = searchResults.find((r) => r.parcel.id === selectedParcelId)
    if (!result?.parcel.coordinates) return

    map.flyTo({
      center: [result.parcel.coordinates.longitude, result.parcel.coordinates.latitude],
      zoom: Math.max(map.getZoom(), 12),
      duration: 500,
    })
  }, [selectedParcelId, searchResults])

  // ── Draw mode ──────────────────────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: maplibregl.MapMouseEvent) => {
      if (!isDrawMode) return
      e.preventDefault()
      drawStartRef.current = e.lngLat
      drawStartPointRef.current = e.point

      const box = document.createElement('div')
      box.style.cssText = `
        position: absolute; pointer-events: none; z-index: 10;
        border: 2px dashed #1e4d2b; background: rgba(30,77,43,0.07);
        left: ${e.point.x}px; top: ${e.point.y}px; width: 0; height: 0;
      `
      containerRef.current?.appendChild(box)
      drawBoxElRef.current = box
    },
    [isDrawMode]
  )

  const handleMouseMove = useCallback(
    (e: maplibregl.MapMouseEvent) => {
      if (!isDrawMode || !drawStartPointRef.current || !drawBoxElRef.current) return
      const start = drawStartPointRef.current
      const cur = e.point
      const minX = Math.min(start.x, cur.x)
      const minY = Math.min(start.y, cur.y)
      drawBoxElRef.current.style.left   = `${minX}px`
      drawBoxElRef.current.style.top    = `${minY}px`
      drawBoxElRef.current.style.width  = `${Math.abs(cur.x - start.x)}px`
      drawBoxElRef.current.style.height = `${Math.abs(cur.y - start.y)}px`
    },
    [isDrawMode]
  )

  const handleMouseUp = useCallback(
    (e: maplibregl.MapMouseEvent) => {
      if (!isDrawMode || !drawStartRef.current) return

      drawBoxElRef.current?.remove()
      drawBoxElRef.current = null

      const start = drawStartRef.current
      const end = e.lngLat
      drawStartRef.current = null
      drawStartPointRef.current = null

      const bbox: BBox = {
        minLng: Math.min(start.lng, end.lng),
        minLat: Math.min(start.lat, end.lat),
        maxLng: Math.max(start.lng, end.lng),
        maxLat: Math.max(start.lat, end.lat),
      }

      setDrawnBBox(bbox)
      setDrawMode(false)
    },
    [isDrawMode, setDrawnBBox, setDrawMode]
  )

  // Attach/detach draw handlers
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
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0 }}
    />
  )
}
