import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, Badge, Typography } from '@hcsneden/design-library'
import { useStore, countActivePreferences } from '../store'
import type { Preferences } from '../store'
import { parcelApi, userApi, unwrap } from '../services/api'
import {
  formatAcreage,
  formatDate,
  formatWaterType,
  formatFlowRate,
  formatVolume,
  formatPrice,
  isMaintainedRoad,
  isPublicRoad,
} from '@lastbestland/shared'
import type {
  WaterRight, ParcelInsight, HuntingDistrict, StreamGauge, RoadAccess, RoadSegment, UtilityAccess,
  EnvironmentalRisk, FloodZone, WildfireRiskRating, MineSite, ConservationEasement, ListingStatus,
} from '@lastbestland/shared'

export function ParcelDetailSheet() {
  const { selectedParcelId, isDetailOpen, searchResults, preferences } = useStore(
    useShallow((state) => ({
      selectedParcelId: state.selectedParcelId,
      isDetailOpen: state.isDetailOpen,
      searchResults: state.searchResults,
      preferences: state.preferences,
    }))
  )
  const setDetailOpen = useStore((state) => state.setDetailOpen)
  const setSelectedParcelBoundary = useStore((state) => state.setSelectedParcelBoundary)
  const queryClient = useQueryClient()

  const resultPreview = searchResults.find((result) => result.parcel.id === selectedParcelId)
  const parcelId = selectedParcelId ?? ''
  const enabled = Boolean(selectedParcelId)

  const parcelQuery = useQuery({ queryKey: ['parcel', parcelId], queryFn: () => parcelApi.getParcel(parcelId).then(unwrap), enabled })
  const waterQuery = useQuery({ queryKey: ['water', parcelId], queryFn: () => parcelApi.getWaterRights(parcelId).then(unwrap), enabled })
  const huntingQuery = useQuery({ queryKey: ['hunting', parcelId], queryFn: () => parcelApi.getHuntingDistricts(parcelId).then(unwrap), enabled })
  const gaugesQuery = useQuery({ queryKey: ['gauges', parcelId], queryFn: () => parcelApi.getStreamGauges(parcelId).then(unwrap), enabled })
  const roadQuery = useQuery({ queryKey: ['road-access', parcelId], queryFn: () => parcelApi.getRoadAccess(parcelId).then(unwrap), enabled })
  const utilitiesQuery = useQuery({ queryKey: ['utilities', parcelId], queryFn: () => parcelApi.getUtilities(parcelId).then(unwrap), enabled })
  const envRiskQuery = useQuery({ queryKey: ['environmental-risk', parcelId], queryFn: () => parcelApi.getEnvironmentalRisk(parcelId).then(unwrap), enabled })
  const easementQuery = useQuery({ queryKey: ['conservation-easements', parcelId], queryFn: () => parcelApi.getConservationEasements(parcelId).then(unwrap), enabled })

  // The summary is generated from the other sources, so it waits for them to
  // settle and their caches to be warm.
  const insightsQuery = useQuery({
    queryKey: ['insights', parcelId],
    queryFn: () => parcelApi.getInsights(parcelId).then(unwrap),
    enabled: enabled && !waterQuery.isLoading && !roadQuery.isLoading && !utilitiesQuery.isLoading && !envRiskQuery.isLoading && !easementQuery.isLoading,
  })

  const navigate = useNavigate()
  const isSignedIn = useStore((state) => state.tokens !== null)

  const saveMutation = useMutation({
    mutationFn: () => userApi.saveParcel(parcelId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['savedParcels'] }),
  })

  // Saving is the one action that needs an account. Send the visitor to sign in
  // and bring them back to this parcel, so they do not lose their place.
  const handleSave = () => {
    if (!isSignedIn) {
      navigate(`/auth?next=${encodeURIComponent(`/parcel/${parcelId}`)}`)
      return
    }
    saveMutation.mutate()
  }

  const parcel = parcelQuery.data
  const acreage = parcel?.acreage ?? resultPreview?.parcel.acreage ?? null
  const county = parcel?.county ?? resultPreview?.parcel.county
  const location = parcel?.address ?? (county !== undefined ? `${county ?? 'Unknown'} County, MT` : null)
  const waterRights = waterQuery.data ?? []
  const insights = insightsQuery.data ?? []
  const easements = easementQuery.data?.easements ?? []

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setDetailOpen])

  useEffect(() => {
    setSelectedParcelBoundary(parcelQuery.data?.boundary ?? null)
    return () => setSelectedParcelBoundary(null)
  }, [parcelQuery.data?.boundary, setSelectedParcelBoundary])

  return (
    <aside className={`detail-sheet ${isDetailOpen ? 'open' : ''}`}>
      <div className="detail-header">
        <div className="detail-header-info">
          <div className="detail-acres">{formatAcreage(acreage)}</div>
          {location && <div className="detail-location">{location}</div>}
        </div>
        <div className="detail-close-wrap">
          <Button variant="ghost" size="sm" onClick={() => setDetailOpen(false)} title="Close (Esc)">
            ×
          </Button>
        </div>
      </div>

      <div className="detail-actions">
        <Button variant="primary" size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
          {saveMutation.isPending
            ? <span className="spinner" />
            : saveMutation.isSuccess ? 'Saved'
            : isSignedIn ? 'Save parcel'
            : 'Sign in to save'}
        </Button>
      </div>

      <LoadingStatus
        parcelLoading={parcelQuery.isLoading}
        waterLoading={waterQuery.isLoading}
        habitatLoading={huntingQuery.isLoading || gaugesQuery.isLoading}
        accessLoading={roadQuery.isLoading || utilitiesQuery.isLoading}
        envLoading={envRiskQuery.isLoading || easementQuery.isLoading}
        insightsLoading={insightsQuery.isLoading}
      />

      <div className="detail-body">
        <ParcelRating
          preferences={preferences}
          acreage={parcel?.acreage ?? null}
          waterRights={waterRights}
          huntingData={huntingQuery.data ?? null}
          gauges={gaugesQuery.data ?? null}
          roadAccess={roadQuery.data ?? null}
          utilities={utilitiesQuery.data ?? null}
          envRisk={envRiskQuery.data ?? null}
          loading={
            parcelQuery.isLoading || waterQuery.isLoading || huntingQuery.isLoading ||
            roadQuery.isLoading || gaugesQuery.isLoading || utilitiesQuery.isLoading || envRiskQuery.isLoading
          }
        />

        {(insightsQuery.isLoading || insights.length > 0) && (
          <Section title="Buildability summary">
            {insightsQuery.isLoading
              ? <LoadingSkeleton rows={4} />
              : insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)}
          </Section>
        )}

        {parcel && (
          <Section title="Property details">
            <DetailRow label="Parcel number" value={parcel.parcelNumber ?? 'N/A'} />
            <DetailRow label="Geocode" value={parcel.geoId ?? 'N/A'} />
            <DetailRow label="County" value={parcel.county ?? 'N/A'} />
            <DetailRow label="State" value="Montana" />
            <DetailRow label="Acreage" value={formatAcreage(parcel.acreage)} />
            <DetailRow label="Dwelling" value={<DwellingValue propType={parcel.propType} buildingValue={parcel.buildingValue} />} />
            <DetailRow
              label="Coordinates"
              value={parcel.coordinates ? `${parcel.coordinates.latitude.toFixed(5)}, ${parcel.coordinates.longitude.toFixed(5)}` : 'N/A'}
            />
          </Section>
        )}

        <Section title="Is this for sale?">
          <ListingStatusSection key={parcelId} parcelId={parcelId} />
        </Section>

        <Section title="Loan calculator">
          <LoanCalculator key={parcelId} />
        </Section>

        <Section title="Water rights">
          {waterQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : waterRights.length === 0 ? (
            <div className="water-warning">
              <div className="water-warning-icon">!</div>
              <div>
                <div className="water-warning-title">No water rights on file</div>
                <div className="water-warning-body">
                  This parcel has no documented water rights in the Montana DNRC database.
                  Verify water access with county records and consult a water rights attorney
                  before purchase. In Montana, no right means no water in dry years.
                </div>
              </div>
            </div>
          ) : (
            waterRights.map((waterRight) => <WaterRightCard key={waterRight.id} waterRight={waterRight} />)
          )}
        </Section>

        <Section title="Hunting districts">
          {huntingQuery.isLoading ? (
            <LoadingSkeleton rows={2} />
          ) : huntingQuery.data?.length ? (
            <HuntingDistrictsSection districts={huntingQuery.data} />
          ) : (
            <div className="detail-empty-note">No hunting districts overlap this parcel</div>
          )}
        </Section>

        <Section title="Nearby stream gauges">
          {gaugesQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : gaugesQuery.data?.length ? (
            gaugesQuery.data.map((gauge) => <StreamGaugeCard key={gauge.id} gauge={gauge} />)
          ) : (
            <div className="detail-empty-note">No USGS gauges within 50 miles</div>
          )}
        </Section>

        <Section title="Road and legal access">
          {roadQuery.isLoading ? <LoadingSkeleton rows={3} />
            : roadQuery.data ? <RoadAccessSection access={roadQuery.data} />
            : <div className="detail-empty-note">Road access data unavailable</div>}
        </Section>

        <Section title="Utilities and grid access">
          {utilitiesQuery.isLoading ? <LoadingSkeleton rows={3} />
            : utilitiesQuery.data ? <UtilityAccessSection access={utilitiesQuery.data} />
            : <div className="detail-empty-note">Utility data unavailable</div>}
        </Section>

        <Section title="Environmental and risk">
          {envRiskQuery.isLoading ? <LoadingSkeleton rows={4} />
            : envRiskQuery.data ? <EnvironmentalRiskSection risk={envRiskQuery.data} />
            : <div className="detail-empty-note">Environmental data unavailable</div>}
        </Section>

        <Section title="Conservation easements">
          {easementQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : easements.length > 0 ? (
            <ConservationEasementSection easements={easements} />
          ) : (
            <Banner tone="ok">
              No conservation easements found in the NCED database
              <div className="road-access-note" style={{ marginTop: 6 }}>
                Verify with county deed records. Easements may exist outside this database.
              </div>
            </Banner>
          )}
        </Section>

        <div style={{ padding: '16px 20px' }}>
          <Typography variant="caption" muted>
            Data sourced from Montana DNRC, Montana Cadastral, and federal GIS services.
            Last Best Land does not guarantee accuracy. Verify water rights, access, and encumbrances
            through county records and a licensed real estate attorney before purchase.
          </Typography>
        </div>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail-row">
      <span className="detail-row-label">{label}</span>
      <span className="detail-row-value">{value}</span>
    </div>
  )
}

function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'neutral'; children: React.ReactNode }) {
  const toneClass = tone === 'ok' ? 'road-access-ok' : tone === 'warn' ? 'road-access-warn' : ''
  return (
    <div className={`road-access-banner ${toneClass}`}>
      <span className="road-access-icon">{tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '?'}</span>
      <div>{children}</div>
    </div>
  )
}

function DwellingValue({ propType, buildingValue }: { propType: string | null; buildingValue: number | null }) {
  if (propType === null) return <span className="detail-row-muted">Unknown</span>
  if (propType !== 'Improved Property') return <span className="detail-dwelling-no">None on record</span>
  return (
    <span className="detail-dwelling-yes">
      Yes
      {buildingValue !== null && <span className="detail-dwelling-value"> · {formatPrice(buildingValue)} assessed</span>}
    </span>
  )
}

interface RatingItem {
  key: string
  label: string
  /** Null while loading or when the source cannot answer. */
  met: boolean | null
  note: string
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function ratingLabel(fraction: number): { label: string; className: string } {
  if (fraction === 1) return { label: 'Strong match', className: 'rating-excellent' }
  if (fraction >= 0.67) return { label: 'Good match', className: 'rating-good' }
  if (fraction >= 0.34) return { label: 'Partial match', className: 'rating-partial' }
  return { label: 'Low match', className: 'rating-poor' }
}

function ParcelRating({
  preferences, acreage, waterRights, huntingData, gauges, roadAccess, utilities, envRisk, loading,
}: {
  preferences: Preferences
  acreage: number | null
  waterRights: WaterRight[]
  huntingData: HuntingDistrict[] | null
  gauges: StreamGauge[] | null
  roadAccess: RoadAccess | null
  utilities: UtilityAccess | null
  envRisk: EnvironmentalRisk | null
  loading: boolean
}) {
  if (countActivePreferences(preferences) === 0) return null

  const activeWater = waterRights.filter((waterRight) => waterRight.status === 'active')
  const huntingSpecies = [...new Set((huntingData ?? []).map((district) => district.species))]
  const maintained = (roadAccess?.segments ?? []).filter((segment) => isMaintainedRoad(segment.type))
  const hasSFHA = (envRisk?.floodZones ?? []).some((zone) => zone.isSpecialFloodHazardArea)
  const floodRiskLevel = envRisk?.floodZones[0]?.riskLevel ?? null
  const wildfireRisk = envRisk?.wildfireRisk ?? null
  const mineSiteCount = envRisk?.mineSites.length ?? 0
  const electric = utilities?.electric
  const pending = { met: null, note: '' }

  const items: RatingItem[] = []
  const { acreageMin, acreageMax } = preferences
  if (acreageMin !== null || acreageMax !== null) {
    const label = acreageMin !== null && acreageMax !== null
      ? `${acreageMin.toLocaleString()} to ${acreageMax.toLocaleString()} acres`
      : acreageMin !== null ? `At least ${acreageMin.toLocaleString()} acres`
      : `At most ${acreageMax!.toLocaleString()} acres`
    const meets = acreage !== null && (acreageMin === null || acreage >= acreageMin) && (acreageMax === null || acreage <= acreageMax)
    items.push({ key: 'acreage', label, ...(loading || acreage === null ? pending : { met: meets, note: `${acreage.toLocaleString()} ac` }) })
  }
  if (preferences.waterRights) {
    items.push({
      key: 'water-rights', label: 'Water rights',
      ...(loading ? pending : {
        met: activeWater.length > 0,
        note: activeWater.length > 0 ? `${activeWater.length} active right${activeWater.length > 1 ? 's' : ''}` : 'None on file',
      }),
    })
  }
  if (preferences.streamAccess) {
    const nearest = gauges?.[0]
    items.push({
      key: 'stream', label: 'Stream access',
      ...(loading ? pending : { met: Boolean(nearest), note: nearest ? nearest.streamName ?? 'Nearby stream' : 'None within 50 mi' }),
    })
  }
  if (preferences.maintainedRoad) {
    const first = maintained[0]
    items.push({
      key: 'road', label: 'Maintained road',
      ...(loading ? pending : { met: Boolean(first), note: first ? first.name ?? ROAD_TYPE_LABELS[first.type] : 'None detected' }),
    })
  }
  if (preferences.huntingAccess) {
    items.push({
      key: 'hunting', label: 'Hunting districts',
      ...(loading ? pending : {
        met: huntingSpecies.length > 0,
        note: huntingSpecies.length > 0 ? huntingSpecies.map(capitalize).join(', ') : 'No districts overlap',
      }),
    })
  }
  if (preferences.electricGrid) {
    const connected = Boolean(electric?.serviceTerritory || electric?.hasNearbyLine)
    items.push({
      key: 'electric', label: 'Electric grid',
      ...(loading ? pending : {
        met: connected,
        note: electric?.serviceTerritory?.utilityName
          ?? (electric?.hasNearbyLine ? electric.voltageClass ?? 'Transmission line nearby' : 'No grid service found'),
      }),
    })
  }
  if (preferences.lowFloodRisk) {
    items.push({
      key: 'flood', label: 'Low flood risk',
      ...(loading ? pending : {
        met: !hasSFHA && (floodRiskLevel === 'minimal' || floodRiskLevel === null),
        note: hasSFHA ? 'SFHA, flood insurance required' : floodRiskLevel ? `${capitalize(floodRiskLevel)} risk` : 'No flood zone overlay',
      }),
    })
  }
  if (preferences.lowWildfireRisk) {
    items.push({
      key: 'wildfire', label: 'Low wildfire risk',
      ...(loading || wildfireRisk === null
        ? { met: null, note: loading ? '' : 'No rating available' }
        : { met: wildfireRisk === 'Low' || wildfireRisk === 'Very Low', note: wildfireRisk }),
    })
  }
  if (preferences.noMineSites) {
    items.push({
      key: 'mines', label: 'No mine sites',
      ...(loading ? pending : {
        met: mineSiteCount === 0,
        note: mineSiteCount === 0 ? 'None within 10 mi' : `${mineSiteCount} site${mineSiteCount > 1 ? 's' : ''} nearby`,
      }),
    })
  }

  const scored = items.filter((item) => item.met !== null)
  const metCount = scored.filter((item) => item.met).length
  const rating = ratingLabel(scored.length > 0 ? metCount / scored.length : 0)

  return (
    <div className="rating-card">
      <div className="rating-card-head">
        <span className="rating-card-title">Match score</span>
        {loading ? (
          <span className="rating-badge-loading">Scoring…</span>
        ) : scored.length > 0 && (
          <span className={`rating-badge ${rating.className}`}>{metCount}/{scored.length}&ensp;{rating.label}</span>
        )}
      </div>
      {!loading && scored.length > 0 && (
        <div className="rating-bar-wrap">
          <div className="rating-bar-track">
            <div className={`rating-bar-fill ${rating.className}`} style={{ width: `${(metCount / scored.length) * 100}%` }} />
          </div>
        </div>
      )}
      <div className="rating-items">
        {items.map((item) => (
          <div key={item.key} className="rating-item">
            <span className={`rating-dot ${item.met === null ? 'rating-dot-loading' : item.met ? 'rating-dot-met' : 'rating-dot-unmet'}`} />
            <span className="rating-item-label">{item.label}</span>
            <span className="rating-item-note">{item.note || (loading ? '…' : '')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Checks run on demand because each one is a web search plus a model call.
function ListingStatusSection({ parcelId }: { parcelId: string }) {
  const check = useMutation({
    mutationFn: (refresh: boolean) => parcelApi.checkListingStatus(parcelId, refresh).then(unwrap),
  })
  const status: ListingStatus | null = check.data ?? null

  if (check.isPending) {
    return (
      <div className="listing-status-prompt">
        <span className="spinner spinner-sm" />
        <Typography variant="body-sm" className="listing-status-hint">Searching the web…</Typography>
      </div>
    )
  }
  if (!status) {
    return (
      <div className="listing-status-prompt">
        <Typography variant="body-sm" className="listing-status-hint">
          {check.isError ? 'Could not check listing status right now.' : "We'll search the web to see if this property is currently listed for sale."}
        </Typography>
        <Button variant={check.isError ? 'ghost' : 'primary'} size="sm" onClick={() => check.mutate(false)}>
          {check.isError ? 'Try again' : 'Check if for sale'}
        </Button>
      </div>
    )
  }
  return (
    <div className={`listing-status-result ${status.forSale ? 'listing-status-for-sale' : 'listing-status-not-found'}`}>
      <div className="listing-status-head">
        <Badge variant={status.forSale ? 'default' : 'subtle'} className={status.forSale ? 'listing-status-badge-for-sale' : undefined}>
          {status.forSale ? 'For sale' : 'Not found for sale'}
        </Badge>
        {status.forSale && status.price !== null && <span className="listing-price">{formatPrice(status.price)}</span>}
      </div>
      <Typography variant="body-sm" className="listing-status-summary">{status.summary}</Typography>
      <div className="listing-status-footer">
        {status.forSale && status.listingUrl && (
          <a href={status.listingUrl} target="_blank" rel="noopener noreferrer" className="listing-link">
            {status.source ? `View on ${status.source}` : 'View listing'}
          </a>
        )}
        <span className="listing-status-checked">Checked {formatDate(status.fetchedAt)}</span>
        <Button variant="ghost" size="sm" onClick={() => check.mutate(true)}>Refresh</Button>
      </div>
    </div>
  )
}

function WaterRightCard({ waterRight }: { waterRight: WaterRight }) {
  return (
    <Card className="wr-card">
      <div className="wr-card-head">
        <code className="wr-number">{waterRight.waterRightNumber ?? 'Unknown'}</code>
        <Badge variant="subtle" className={`wr-status-${waterRight.status}`}>{waterRight.status}</Badge>
      </div>
      <div className="wr-body">
        <div className="wr-field">
          <div className="wr-field-label">Source</div>
          <div className="wr-field-value">{waterRight.waterSource || 'Unknown'}</div>
        </div>
        <div className="wr-field">
          <div className="wr-field-label">Type</div>
          <div className="wr-field-value">{formatWaterType(waterRight.waterType)}</div>
        </div>
        {waterRight.flowRateGpm !== null && (
          <div className="wr-field">
            <div className="wr-field-label">Flow rate</div>
            <div className="wr-field-value">{formatFlowRate(waterRight.flowRateGpm)}</div>
          </div>
        )}
        {waterRight.volumeAcreFeet !== null && (
          <div className="wr-field">
            <div className="wr-field-label">Volume</div>
            <div className="wr-field-value">{formatVolume(waterRight.volumeAcreFeet)}</div>
          </div>
        )}
        {waterRight.priorityDate && (
          <div className="wr-field" style={{ gridColumn: '1 / -1' }}>
            <div className="wr-field-label">Priority date</div>
            <div className="wr-field-value wr-priority">{formatDate(waterRight.priorityDate)}</div>
          </div>
        )}
      </div>
    </Card>
  )
}

function InsightCard({ insight }: { insight: ParcelInsight }) {
  const sentences = insight.content.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean)
  return (
    <div className="insight-callout">
      <div className="insight-sentences">
        {sentences.map((sentence, index) => <p key={index} className="insight-sentence">{sentence}</p>)}
      </div>
      <div className="insight-meta">Generated {formatDate(insight.createdAt)}</div>
    </div>
  )
}

function LoadingStatus(flags: {
  parcelLoading: boolean
  waterLoading: boolean
  habitatLoading: boolean
  accessLoading: boolean
  envLoading: boolean
  insightsLoading: boolean
}) {
  const label =
    flags.parcelLoading ? 'Loading parcel details…'
    : flags.waterLoading ? 'Fetching water rights from DNRC…'
    : flags.habitatLoading ? 'Loading habitat data…'
    : flags.accessLoading ? 'Checking road and utility access…'
    : flags.envLoading ? 'Checking environmental risks…'
    : flags.insightsLoading ? 'Generating buildability summary…'
    : null
  if (!label) return null
  return (
    <div className="detail-loading-status">
      <span className="spinner spinner-sm" />
      {label}
    </div>
  )
}

function LoadingSkeleton({ rows }: { rows: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, borderRadius: 4, width: `${70 + (i % 3) * 10}%` }} />
      ))}
    </div>
  )
}

function HuntingDistrictsSection({ districts }: { districts: HuntingDistrict[] }) {
  const bySpecies = new Map<string, string[]>()
  for (const district of districts) {
    bySpecies.set(district.species, [...(bySpecies.get(district.species) ?? []), district.districtNumber])
  }
  return (
    <>
      {[...bySpecies].map(([species, numbers]) => (
        <div key={species} className="detail-row">
          <span className="detail-row-label" style={{ textTransform: 'capitalize' }}>{species.replace(/_/g, ' ')}</span>
          <span className="detail-row-value">District {numbers.join(', ')}</span>
        </div>
      ))}
    </>
  )
}

const MONTH_LABELS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

function StreamGaugeCard({ gauge }: { gauge: StreamGauge }) {
  const monthlyFlows = MONTH_LABELS.map((_, index) => gauge.monthlyAveragesCfs[index + 1] ?? 0)
  const maxFlowCfs = Math.max(...monthlyFlows, 1)
  const hasMonthlyFlows = monthlyFlows.some((flowCfs) => flowCfs > 0)

  return (
    <div className="gauge-card">
      <div className="gauge-card-head">
        <div className="gauge-card-name-wrap">
          <div className="gauge-card-name">{gauge.streamName ?? gauge.siteName}</div>
          {gauge.streamName && <div className="gauge-card-site">{gauge.siteName}</div>}
        </div>
        <div className="gauge-card-distance">{gauge.distanceMiles} mi</div>
      </div>
      {gauge.latestFlowCfs !== null && (
        <div className="gauge-latest">
          <span className="gauge-latest-label">Current</span>
          <span className="gauge-latest-value">{gauge.latestFlowCfs.toFixed(1)} cfs</span>
          {gauge.latestReadingDate && <span className="gauge-latest-date">as of {formatDate(gauge.latestReadingDate)}</span>}
        </div>
      )}
      {hasMonthlyFlows && (
        <div className="gauge-bars">
          {monthlyFlows.map((flowCfs, index) => (
            <div key={index} className="gauge-bar-col">
              <div className="gauge-bar-track">
                <div className="gauge-bar-fill" style={{ height: `${Math.round((flowCfs / maxFlowCfs) * 100)}%` }} />
              </div>
              <div className="gauge-bar-label">{MONTH_LABELS[index]}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ROAD_TYPE_LABELS: Record<RoadSegment['type'], string> = {
  highway: 'Highway',
  county: 'County road',
  local: 'Local road',
  trail: '4WD trail',
  forest: 'Forest road',
  blm: 'BLM road',
  unknown: 'Road',
}

const SOURCE_LABELS: Record<RoadSegment['source'], string> = {
  tiger: 'TIGER/Census',
  blm: 'BLM',
  usfs: 'USFS',
}

function roadTypeClass(type: RoadSegment['type']): string {
  if (type === 'highway' || type === 'county') return 'road-type-primary'
  if (isPublicRoad(type)) return 'road-type-secondary'
  return 'road-type-rough'
}

function RoadItem({ segment }: { segment: RoadSegment }) {
  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className={`road-type-pill ${roadTypeClass(segment.type)}`}>{ROAD_TYPE_LABELS[segment.type]}</span>
        <span className="road-item-name">{segment.name ?? 'Unnamed'}</span>
      </div>
      <div className="road-item-right">
        {segment.surfaceType && <span className="road-surface">{segment.surfaceType}</span>}
        {segment.maintLevel !== null && <span className="road-maint">maint {segment.maintLevel}</span>}
        <span className="road-source">{SOURCE_LABELS[segment.source]}</span>
      </div>
    </div>
  )
}

function RoadAccessSection({ access }: { access: RoadAccess }) {
  const publicRoads = access.segments.filter((segment) => isPublicRoad(segment.type))
  const roughRoads = access.segments.filter((segment) => segment.type === 'trail')

  return (
    <div>
      {access.hasPublicAccess
        ? <Banner tone="ok">Public road access detected</Banner>
        : <Banner tone="warn">No public road detected. Verify legal access before purchase.</Banner>}
      {publicRoads.length > 0 && (
        <div className="road-list">
          {publicRoads.map((segment, i) => <RoadItem key={i} segment={segment} />)}
        </div>
      )}
      {roughRoads.length > 0 && (
        <div className="road-list road-list-rough">
          <div className="road-list-subhead">Rough or high-clearance only</div>
          {roughRoads.map((segment, i) => <RoadItem key={i} segment={segment} />)}
        </div>
      )}
      {access.segments.length === 0 && (
        <div className="detail-empty-note" style={{ marginTop: 8 }}>No roads found within 150 m of this parcel</div>
      )}
      <div className="road-access-note">
        Easements and private access rights require a title search and are not reflected above.
      </div>
    </div>
  )
}

function UtilityAccessSection({ access }: { access: UtilityAccess }) {
  const { electric } = access
  return (
    <div>
      {electric.serviceTerritory && (
        <>
          <Banner tone="ok">Within utility service territory</Banner>
          <div className="road-list">
            <div className="road-item">
              <div className="road-item-left">
                {electric.serviceTerritory.utilityType && (
                  <span className="road-type-pill road-type-primary">{electric.serviceTerritory.utilityType}</span>
                )}
                <span className="road-item-name">{electric.serviceTerritory.utilityName}</span>
              </div>
            </div>
          </div>
        </>
      )}
      {electric.hasNearbyLine && (
        <>
          <Banner tone="ok">Transmission line within 10 miles</Banner>
          <div className="road-list">
            <div className="road-item">
              <div className="road-item-left">
                {electric.voltageClass && <span className="road-type-pill road-type-primary">{electric.voltageClass}</span>}
                <span className="road-item-name">{electric.lineType ?? 'Transmission'}</span>
              </div>
              {electric.owner && (
                <div className="road-item-right"><span className="road-source">{electric.owner}</span></div>
              )}
            </div>
          </div>
        </>
      )}
      {!electric.serviceTerritory && !electric.hasNearbyLine && (
        <Banner tone="warn">No utility service territory or transmission lines found. Off-grid power is likely required.</Banner>
      )}
      <div className="road-access-note">
        Service territory data comes from EIA through HIFLD. It confirms a utility's coverage area,
        not active service at the parcel. Contact the utility for a connection quote.
      </div>
    </div>
  )
}

const FLOOD_RISK_LABELS: Record<FloodZone['riskLevel'], string> = {
  high: 'High flood risk',
  moderate: 'Moderate flood risk',
  minimal: 'Minimal flood risk',
  undetermined: 'Undetermined flood zone',
}

const FLOOD_RISK_TONE: Record<FloodZone['riskLevel'], 'ok' | 'warn' | 'neutral'> = {
  high: 'warn',
  moderate: 'warn',
  minimal: 'ok',
  undetermined: 'neutral',
}

const WILDFIRE_RISK_CLASS: Record<WildfireRiskRating, string> = {
  'Very High': 'risk-pill-high',
  'High': 'risk-pill-high',
  'Medium': 'risk-pill-medium',
  'Low': 'risk-pill-low',
  'Very Low': 'risk-pill-low',
}

function FloodZoneRow({ zone }: { zone: FloodZone }) {
  const pillClass = zone.riskLevel === 'high' ? 'road-type-rough' : zone.riskLevel === 'moderate' ? 'road-type-secondary' : 'road-type-primary'
  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className={`road-type-pill ${pillClass}`}>Zone {zone.zone}</span>
        {zone.subtype && <span className="road-item-name">{zone.subtype}</span>}
      </div>
      <div className="road-item-right">
        {zone.isSpecialFloodHazardArea && <span className="road-surface">SFHA</span>}
        <span className="road-source">{FLOOD_RISK_LABELS[zone.riskLevel]}</span>
      </div>
    </div>
  )
}

function MineSiteRow({ mine }: { mine: MineSite }) {
  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className="road-type-pill road-type-rough">{mine.devStatus ?? 'Mine site'}</span>
        <span className="road-item-name">{mine.name ?? 'Unnamed site'}</span>
      </div>
      {mine.commodities && <div className="road-item-right"><span className="road-source">{mine.commodities}</span></div>}
    </div>
  )
}

function EnvironmentalRiskSection({ risk }: { risk: EnvironmentalRisk }) {
  const { floodZones, wildfireRisk, mineSites } = risk
  const worstFlood = floodZones[0]
  const hasSFHA = floodZones.some((zone) => zone.isSpecialFloodHazardArea)

  return (
    <div>
      <div className="utility-subsection">
        <div className="utility-subsection-label">Flood zone</div>
        {!worstFlood ? (
          <Banner tone="ok">No FEMA flood zone overlay at this parcel</Banner>
        ) : (
          <>
            <Banner tone={FLOOD_RISK_TONE[worstFlood.riskLevel]}>
              {hasSFHA ? 'Special Flood Hazard Area. Federal flood insurance may be required.' : FLOOD_RISK_LABELS[worstFlood.riskLevel]}
            </Banner>
            <div className="road-list">
              {floodZones.map((zone, index) => <FloodZoneRow key={index} zone={zone} />)}
            </div>
          </>
        )}
        <div className="road-access-note">
          FEMA flood maps may not reflect current conditions. Verify with a licensed surveyor and
          check for active LOMAs before purchase.
        </div>
      </div>

      <div className="utility-subsection" style={{ marginTop: 14 }}>
        <div className="utility-subsection-label">Wildfire risk</div>
        {wildfireRisk === null ? (
          <div className="detail-empty-note">No wildfire risk rating available for this area</div>
        ) : (
          <DetailRow
            label="FEMA NRI rating"
            value={<Badge variant="subtle" className={`road-type-pill ${WILDFIRE_RISK_CLASS[wildfireRisk]}`}>{wildfireRisk}</Badge>}
          />
        )}
        <div className="road-access-note" style={{ marginTop: 6 }}>
          Based on FEMA National Risk Index census tract data. High-risk areas may affect insurance
          availability and defensible-space requirements.
        </div>
      </div>

      <div className="utility-subsection" style={{ marginTop: 14 }}>
        <div className="utility-subsection-label">Nearby mine sites</div>
        {mineSites.length === 0 ? (
          <div className="detail-empty-note">No USGS-recorded mine sites within 10 miles</div>
        ) : (
          <div className="road-list">
            {mineSites.map((mineSite, index) => <MineSiteRow key={index} mine={mineSite} />)}
          </div>
        )}
        <div className="road-access-note" style={{ marginTop: 6 }}>
          USGS Mineral Resources Data System. Proximity to mines may indicate contamination risk.
          Consult a Phase I or II environmental assessment before purchase.
        </div>
      </div>
    </div>
  )
}

function monthlyPayment(principal: number, annualRatePercent: number, years: number): number {
  const monthlyRate = annualRatePercent / 100 / 12
  const payments = years * 12
  if (principal <= 0 || monthlyRate <= 0 || payments <= 0) return 0
  const growth = Math.pow(1 + monthlyRate, payments)
  return (principal * monthlyRate * growth) / (growth - 1)
}

function LoanCalculator() {
  const [purchasePrice, setPurchasePrice] = useState('')
  const [downPercent, setDownPercent] = useState('20')
  const [rate, setRate] = useState('8.5')
  const [termYears, setTermYears] = useState('15')

  const price = Number.parseFloat(purchasePrice) || 0
  const down = Math.min(Math.max(Number.parseFloat(downPercent) || 0, 0), 100)
  const monthly = monthlyPayment(price * (1 - down / 100), Number.parseFloat(rate) || 0, Number.parseInt(termYears, 10) || 0)

  const numberInput = (value: string, onChange: (value: string) => void, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input type="number" className="loan-input loan-input-sm" value={value} onChange={(event) => onChange(event.target.value)} {...extra} />
  )

  return (
    <div>
      <DetailRow
        label="Purchase price"
        value={<input type="number" className="loan-input" value={purchasePrice} min={0} placeholder="Enter price" onChange={(event) => setPurchasePrice(event.target.value)} />}
      />
      <DetailRow
        label="Down payment"
        value={
          <>
            {numberInput(downPercent, setDownPercent, { min: 0, max: 100 })}
            <span className="loan-input-suffix">%</span>
            {price > 0 && <span className="loan-input-computed"> = {formatPrice(Math.round((price * down) / 100))}</span>}
          </>
        }
      />
      <DetailRow label="Interest rate" value={<>{numberInput(rate, setRate, { min: 0, max: 30, step: 0.1 })}<span className="loan-input-suffix">% / yr</span></>} />
      <DetailRow label="Loan term" value={<>{numberInput(termYears, setTermYears, { min: 1, max: 30 })}<span className="loan-input-suffix">years</span></>} />
      {monthly > 0 && (
        <div className="loan-result">
          <span className="loan-result-label">Est. monthly P&amp;I</span>
          <span className="loan-result-amount">{formatPrice(Math.round(monthly))}/mo</span>
        </div>
      )}
      <div className="loan-note">
        Land loans typically carry higher rates (7 to 11%) and shorter terms than residential
        mortgages. Consult a lender for an accurate quote.
      </div>
    </div>
  )
}

function ConservationEasementSection({ easements }: { easements: ConservationEasement[] }) {
  return (
    <div>
      <Banner tone="warn">
        {easements.length} conservation easement{easements.length > 1 ? 's' : ''} found. Development restrictions may apply.
      </Banner>
      <div className="road-list">
        {easements.map((easement, index) => (
          <div key={index} className="easement-card">
            <div className="easement-holder">{easement.holderName ?? 'Unknown holder'}</div>
            {easement.purpose && <div className="easement-field"><span className="easement-field-label">Purpose</span> {easement.purpose}</div>}
            {easement.restrictions && <div className="easement-field"><span className="easement-field-label">Restrictions</span> {easement.restrictions}</div>}
            <div className="easement-meta">
              {easement.acreage !== null && <span>{easement.acreage.toLocaleString()} ac</span>}
              {easement.dateRecorded && <span>Recorded {formatDate(easement.dateRecorded)}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="road-access-note">
        Source: National Conservation Easement Database (NCED). Verify restrictions with a
        real estate attorney. Easement terms vary and affect building, subdivision, and use.
      </div>
    </div>
  )
}
