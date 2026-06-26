import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardContent, Badge, Typography } from '@hcsneden/design-library'
import { useStore } from '../store'
import { parcelApi, userApi } from '../services/api'
import {
  formatAcreage,
  formatDate,
  formatWaterType,
  formatFlowRate,
  formatVolume,
} from '@landfinder/shared'
import type { WaterRight, ParcelInsight, HuntingDistrict, StreamGauge, RoadAccess, RoadSegment } from '@landfinder/shared'

export function ParcelDetailSheet() {
  const { selectedParcelId, isDetailOpen, searchResults, setDetailOpen } = useStore()
  const qc = useQueryClient()

  const resultPreview = searchResults.find((r) => r.parcel.id === selectedParcelId)

  const parcelQ = useQuery({
    queryKey: ['parcel', selectedParcelId],
    queryFn: () => parcelApi.getParcel(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const waterQ = useQuery({
    queryKey: ['water', selectedParcelId],
    queryFn: () => parcelApi.getWaterRights(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const insightsQ = useQuery({
    queryKey: ['insights', selectedParcelId],
    queryFn: () => parcelApi.getInsights(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const huntingQ = useQuery({
    queryKey: ['hunting', selectedParcelId],
    queryFn: () => parcelApi.getHuntingDistricts(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const gaugesQ = useQuery({
    queryKey: ['gauges', selectedParcelId],
    queryFn: () => parcelApi.getStreamGauges(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const roadQ = useQuery({
    queryKey: ['road-access', selectedParcelId],
    queryFn: () => parcelApi.getRoadAccess(selectedParcelId!).then((r) => {
      if (!r.success || !r.data) throw new Error(r.error?.message)
      return r.data
    }),
    enabled: !!selectedParcelId,
  })

  const saveMutation = useMutation({
    mutationFn: () => userApi.saveParcel(selectedParcelId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['savedParcels'] }),
  })

  const parcel = parcelQ.data
  const acreage = parcel?.acreage ?? resultPreview?.parcel.acreage ?? null
  const location = parcel?.address
    ?? (parcel ? `${parcel.county ?? 'Unknown'} County, MT` : null)
    ?? (resultPreview ? `${resultPreview.parcel.county ?? 'Unknown'} County, MT` : null)

  const waterRights: WaterRight[] = waterQ.data ?? []
  const insights: ParcelInsight[] = insightsQ.data ?? []

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setDetailOpen])

  return (
    <aside className={`detail-sheet ${isDetailOpen ? 'open' : ''}`}>
      {/* ── Header ── */}
      <div className="detail-header">
        <div className="detail-header-info">
          <div className="detail-acres">{formatAcreage(acreage)}</div>
          {location && <div className="detail-location">{location}</div>}
        </div>
        <div className="detail-close-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDetailOpen(false)}
            title="Close (Esc)"
          >
            ×
          </Button>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="detail-actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? (
            <span className="spinner" />
          ) : saveMutation.isSuccess ? '✓ Saved' : '♡ Save parcel'}
        </Button>
      </div>

      {/* ── Body ── */}
      <div className="detail-body">
        {/* Property Details */}
        {parcel && (
          <div className="detail-section">
            <div className="section-title">Property Details</div>
            <div className="detail-row">
              <span className="detail-row-label">Parcel Number</span>
              <span className="detail-row-value">{parcel.parcelNumber ?? 'N/A'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Geocode</span>
              <span className="detail-row-value">{parcel.geoId ?? 'N/A'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">County</span>
              <span className="detail-row-value">{parcel.county ?? 'N/A'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">State</span>
              <span className="detail-row-value">Montana</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Acreage</span>
              <span className="detail-row-value">{formatAcreage(parcel.acreage)}</span>
            </div>
            <div className="detail-row">
              <span className="detail-row-label">Coordinates</span>
              <span className="detail-row-value">
                {parcel.coordinates
                  ? `${parcel.coordinates.latitude.toFixed(5)}, ${parcel.coordinates.longitude.toFixed(5)}`
                  : 'N/A'}
              </span>
            </div>
          </div>
        )}

        {/* Water Rights */}
        <div className="detail-section">
          <div className="section-title">Water Rights</div>

          {waterQ.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : waterRights.length === 0 ? (
            <div className="water-warning">
              <div className="water-warning-icon">!</div>
              <div>
                <div className="water-warning-title">No Water Rights on File</div>
                <div className="water-warning-body">
                  This parcel has no documented water rights in the Montana DNRC database.
                  Verify water access with county records and consult a water rights attorney
                  before purchase. In Montana, no right = no water in dry years.
                </div>
              </div>
            </div>
          ) : (
            waterRights.map((wr) => <WaterRightCard key={wr.id} wr={wr} />)
          )}
        </div>

        {/* Hunting Districts */}
        <div className="detail-section">
          <div className="section-title">Hunting Districts</div>
          {huntingQ.isLoading ? (
            <LoadingSkeleton rows={2} />
          ) : (huntingQ.data?.length ?? 0) > 0 ? (
            <HuntingDistrictsSection districts={huntingQ.data!} />
          ) : (
            <div className="detail-empty-note">No hunting districts overlap this parcel</div>
          )}
        </div>

        {/* Stream Gauges */}
        <div className="detail-section">
          <div className="section-title">Nearby Stream Gauges</div>
          {gaugesQ.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : (gaugesQ.data?.length ?? 0) > 0 ? (
            gaugesQ.data!.map((g) => <StreamGaugeCard key={g.id} gauge={g} />)
          ) : (
            <div className="detail-empty-note">No USGS gauges within 50 miles</div>
          )}
        </div>

        {/* Road & Legal Access */}
        <div className="detail-section">
          <div className="section-title">Road & Legal Access</div>
          {roadQ.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : roadQ.data ? (
            <RoadAccessSection access={roadQ.data} />
          ) : (
            <div className="detail-empty-note">Road access data unavailable</div>
          )}
        </div>

        {/* Utility Access */}
        <div className="detail-section">
          <div className="section-title">Utilities & Grid Access</div>
          <ComingSoon label="Utility data" />
        </div>

        {/* Environmental */}
        <div className="detail-section">
          <div className="section-title">Environmental & Risk</div>
          <ComingSoon label="Wildfire risk, flood zone, mining history" />
        </div>

        {/* AI Insights */}
        {(insightsQ.isLoading || insights.length > 0) && (
          <div className="detail-section">
            <div className="section-title">AI Insights</div>
            {insightsQ.isLoading ? (
              <LoadingSkeleton rows={4} />
            ) : (
              insights.map((i) => <InsightCard key={i.id} insight={i} />)
            )}
          </div>
        )}

        {/* Data disclaimer */}
        <div style={{ padding: '16px 20px' }}>
          <Typography variant="caption" muted>
            Data sourced from Montana DNRC, Montana Cadastral, and public listing aggregators.
            LandFinder does not guarantee accuracy. Verify water rights, access, and encumbrances
            through county records and a licensed real estate attorney before purchase.
          </Typography>
        </div>
      </div>
    </aside>
  )
}

function WaterRightCard({ wr }: { wr: WaterRight }) {
  const statusClass = `wr-status-${wr.status}`
  return (
    <Card className="wr-card">
      <div className="wr-card-head">
        <code className="wr-number">{wr.waterRightNumber ?? 'Unknown'}</code>
        <Badge variant="subtle" className={statusClass}>
          {wr.status}
        </Badge>
      </div>
      <div className="wr-body">
        <div className="wr-field">
          <div className="wr-field-label">Source</div>
          <div className="wr-field-value">{wr.waterSource || 'Unknown'}</div>
        </div>
        <div className="wr-field">
          <div className="wr-field-label">Type</div>
          <div className="wr-field-value">{formatWaterType(wr.waterType)}</div>
        </div>
        {wr.flowRate != null && (
          <div className="wr-field">
            <div className="wr-field-label">Flow Rate</div>
            <div className="wr-field-value">{formatFlowRate(wr.flowRate)}</div>
          </div>
        )}
        {wr.volume != null && (
          <div className="wr-field">
            <div className="wr-field-label">Volume</div>
            <div className="wr-field-value">{formatVolume(wr.volume)}</div>
          </div>
        )}
        {wr.priorityDate && (
          <div className="wr-field" style={{ gridColumn: '1 / -1' }}>
            <div className="wr-field-label">Priority Date</div>
            <div className="wr-field-value wr-priority">{formatDate(wr.priorityDate)}</div>
          </div>
        )}
      </div>
    </Card>
  )
}

function InsightCard({ insight }: { insight: ParcelInsight }) {
  const titles: Record<string, string> = {
    summary: 'Summary',
    water_analysis: 'Water Analysis',
    due_diligence: 'Due Diligence',
    comparable_properties: 'Comparable Properties',
    potential_issues: 'Potential Issues',
  }
  return (
    <Card className="insight-card-wrap">
      <CardContent className="insight-card-content">
        <Badge variant="subtle" className="insight-type-badge">
          {titles[insight.insightType] ?? insight.insightType}
        </Badge>
        <Typography variant="body-sm" className="insight-body">
          {insight.content}
        </Typography>
        <span className="insight-meta">Generated {formatDate(insight.createdAt)}</span>
      </CardContent>
    </Card>
  )
}

function LoadingSkeleton({ rows }: { rows: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ height: 18, borderRadius: 4, width: `${70 + (i % 3) * 10}%` }}
        />
      ))}
    </div>
  )
}

function HuntingDistrictsSection({ districts }: { districts: HuntingDistrict[] }) {
  const bySpecies: Record<string, string[]> = {}
  for (const d of districts) {
    if (!bySpecies[d.species]) bySpecies[d.species] = []
    bySpecies[d.species]!.push(d.districtNumber)
  }
  return (
    <>
      {Object.entries(bySpecies).map(([species, numbers]) => (
        <div key={species} className="detail-row">
          <span className="detail-row-label" style={{ textTransform: 'capitalize' }}>{species}</span>
          <span className="detail-row-value">District {numbers.join(', ')}</span>
        </div>
      ))}
    </>
  )
}

const MONTH_LABELS = ['J','F','M','A','M','J','J','A','S','O','N','D']

function StreamGaugeCard({ gauge }: { gauge: StreamGauge }) {
  const avgs = gauge.monthlyAveragesCfs
  const monthEntries = Array.from({ length: 12 }, (_, i) => avgs[i + 1] ?? 0)
  const maxCfs = Math.max(...monthEntries, 1)
  const hasMonthly = monthEntries.some((v) => v > 0)
  const displayName = gauge.streamName ?? gauge.siteName

  return (
    <div className="gauge-card">
      <div className="gauge-card-head">
        <div className="gauge-card-name-wrap">
          <div className="gauge-card-name">{displayName}</div>
          {gauge.streamName && gauge.streamName !== gauge.siteName && (
            <div className="gauge-card-site">{gauge.siteName}</div>
          )}
        </div>
        <div className="gauge-card-distance">{gauge.distanceMiles} mi</div>
      </div>
      {gauge.latestFlowCfs != null && (
        <div className="gauge-latest">
          <span className="gauge-latest-label">Current</span>
          <span className="gauge-latest-value">{gauge.latestFlowCfs.toFixed(1)} cfs</span>
          {gauge.latestReadingDate && (
            <span className="gauge-latest-date">as of {formatDate(gauge.latestReadingDate)}</span>
          )}
        </div>
      )}
      {hasMonthly && (
        <div className="gauge-bars">
          {monthEntries.map((cfs, i) => (
            <div key={i} className="gauge-bar-col">
              <div className="gauge-bar-track">
                <div
                  className="gauge-bar-fill"
                  style={{ height: `${Math.round((cfs / maxCfs) * 100)}%` }}
                />
              </div>
              <div className="gauge-bar-label">{MONTH_LABELS[i]}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ROAD_TYPE_LABELS: Record<string, string> = {
  highway: 'Highway',
  county:  'County Road',
  local:   'Local Road',
  trail:   '4WD Trail',
  forest:  'Forest Road',
  blm:     'BLM Road',
  unknown: 'Road',
}

const SOURCE_LABELS: Record<string, string> = {
  tiger: 'TIGER/Census',
  blm:   'BLM',
  usfs:  'USFS',
}

function roadTypeClass(type: RoadSegment['type']): string {
  if (type === 'highway' || type === 'county') return 'road-type-primary'
  if (type === 'local' || type === 'forest' || type === 'blm') return 'road-type-secondary'
  return 'road-type-rough'
}

function RoadAccessSection({ access }: { access: RoadAccess }) {
  const publicTypes = new Set(['highway', 'county', 'local', 'forest', 'blm'])
  const publicRoads = access.segments.filter((s) => publicTypes.has(s.type))
  const roughRoads = access.segments.filter((s) => s.type === 'trail')

  return (
    <div>
      {access.hasPublicAccess ? (
        <div className="road-access-banner road-access-ok">
          <span className="road-access-icon">✓</span>
          Public road access detected
        </div>
      ) : (
        <div className="road-access-banner road-access-warn">
          <span className="road-access-icon">!</span>
          No public road detected — verify legal access before purchase
        </div>
      )}

      {publicRoads.length > 0 && (
        <div className="road-list">
          {publicRoads.map((seg, i) => (
            <div key={i} className="road-item">
              <div className="road-item-left">
                <span className={`road-type-pill ${roadTypeClass(seg.type)}`}>
                  {ROAD_TYPE_LABELS[seg.type] ?? seg.type}
                </span>
                <span className="road-item-name">{seg.name ?? 'Unnamed'}</span>
              </div>
              <div className="road-item-right">
                {seg.surfaceType && (
                  <span className="road-surface">{seg.surfaceType}</span>
                )}
                {seg.maintLevel != null && (
                  <span className="road-maint">maint {seg.maintLevel}</span>
                )}
                <span className="road-source">{SOURCE_LABELS[seg.source] ?? seg.source}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {roughRoads.length > 0 && (
        <div className="road-list road-list-rough">
          <div className="road-list-subhead">Rough / High-Clearance Only</div>
          {roughRoads.map((seg, i) => (
            <div key={i} className="road-item">
              <div className="road-item-left">
                <span className={`road-type-pill ${roadTypeClass(seg.type)}`}>
                  {ROAD_TYPE_LABELS[seg.type] ?? seg.type}
                </span>
                <span className="road-item-name">{seg.name ?? 'Unnamed'}</span>
              </div>
              <div className="road-item-right">
                {seg.surfaceType && <span className="road-surface">{seg.surfaceType}</span>}
                <span className="road-source">{SOURCE_LABELS[seg.source] ?? seg.source}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {access.segments.length === 0 && (
        <div className="detail-empty-note" style={{ marginTop: 8 }}>
          No roads found within 150 m of this parcel
        </div>
      )}

      <div className="road-access-note">
        Easements and private access rights require a title search — not reflected above.
      </div>
    </div>
  )
}

function ComingSoon({ label }: { label: string }) {
  return (
    <Card className="coming-soon-card">
      <CardContent>
        <span style={{ opacity: 0.5 }}>○</span>
        {label} — enrichment pipeline coming soon
      </CardContent>
    </Card>
  )
}
