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
import type { WaterRight, ParcelInsight } from '@landfinder/shared'

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

        {/* Road & Access */}
        <div className="detail-section">
          <div className="section-title">Road & Legal Access</div>
          <ComingSoon label="Access data" />
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
