import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Card, CardContent, Badge, Typography } from '@hcsneden/design-library'
import { useStore } from '../store'
import type { Preferences } from '../store'
import { parcelApi, userApi } from '../services/api'
import {
  formatAcreage,
  formatDate,
  formatWaterType,
  formatFlowRate,
  formatVolume,
  formatPrice,
  formatPricePerAcre,
  getListingSourceLabel,
} from '@lastbestland/shared'
import type { WaterRight, Listing, ParcelInsight, HuntingDistrict, StreamGauge, RoadAccess, RoadSegment, UtilityAccess, BroadbandProvider, EnvironmentalRisk, FloodZone, WildfireRiskRating, MineSite, ConservationEasement, ListingStatus } from '@lastbestland/shared'

function unwrap<T>(r: { success: boolean; data?: T; error?: { message?: string } }): T {
  if (!r.success || !r.data) throw new Error(r.error?.message)
  return r.data
}

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

  const parcelQuery = useQuery({
    queryKey: ['parcel', selectedParcelId],
    queryFn: () => parcelApi.getParcel(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const waterQuery = useQuery({
    queryKey: ['water', selectedParcelId],
    queryFn: () => parcelApi.getWaterRights(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const huntingQuery = useQuery({
    queryKey: ['hunting', selectedParcelId],
    queryFn: () => parcelApi.getHuntingDistricts(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const gaugesQuery = useQuery({
    queryKey: ['gauges', selectedParcelId],
    queryFn: () => parcelApi.getStreamGauges(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const roadQuery = useQuery({
    queryKey: ['road-access', selectedParcelId],
    queryFn: () => parcelApi.getRoadAccess(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const utilitiesQuery = useQuery({
    queryKey: ['utilities', selectedParcelId],
    queryFn: () => parcelApi.getUtilities(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const envRiskQuery = useQuery({
    queryKey: ['environmental-risk', selectedParcelId],
    queryFn: () => parcelApi.getEnvironmentalRisk(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const listingsQuery = useQuery({
    queryKey: ['listings', selectedParcelId],
    queryFn: () => parcelApi.getListings(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const easementQuery = useQuery({
    queryKey: ['conservation-easements', selectedParcelId],
    queryFn: () => parcelApi.getConservationEasements(selectedParcelId!).then(unwrap),
    enabled: !!selectedParcelId,
  })

  const insightsQuery = useQuery({
    queryKey: ['insights', selectedParcelId],
    queryFn: () => parcelApi.getInsights(selectedParcelId!).then(unwrap),
    // Wait for the data that feeds the summary before firing, so the backend
    // always has warm caches when it generates the insight.
    enabled: !!selectedParcelId &&
      !waterQuery.isLoading &&
      !roadQuery.isLoading &&
      !utilitiesQuery.isLoading &&
      !envRiskQuery.isLoading &&
      !easementQuery.isLoading,
  })

  const saveMutation = useMutation({
    mutationFn: () => userApi.saveParcel(selectedParcelId!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['savedParcels'] }),
  })

  // On-demand, not auto-run on open — each check is a Claude + web-search call.
  const listingStatusMutation = useMutation({
    mutationFn: () => parcelApi.checkListingStatus(selectedParcelId!).then(unwrap),
  })

  const parcel = parcelQuery.data
  const acreage = parcel?.acreage ?? resultPreview?.parcel.acreage ?? null
  const location = parcel?.address
    ?? (parcel ? `${parcel.county ?? 'Unknown'} County, MT` : null)
    ?? (resultPreview ? `${resultPreview.parcel.county ?? 'Unknown'} County, MT` : null)

  const waterRights: WaterRight[] = waterQuery.data ?? []
  const insights: ParcelInsight[] = insightsQuery.data ?? []

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setDetailOpen])

  useEffect(() => {
    listingStatusMutation.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedParcelId])

  useEffect(() => {
    setSelectedParcelBoundary(parcelQuery.data?.boundary ?? null)
    return () => setSelectedParcelBoundary(null)
  }, [parcelQuery.data?.boundary, setSelectedParcelBoundary])

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

      {/* ── Loading status ── */}
      <LoadingStatus
        parcelLoading={parcelQuery.isLoading}
        waterLoading={waterQuery.isLoading}
        habitatLoading={huntingQuery.isLoading || gaugesQuery.isLoading}
        accessLoading={roadQuery.isLoading || utilitiesQuery.isLoading}
        envLoading={envRiskQuery.isLoading || easementQuery.isLoading}
        insightsLoading={insightsQuery.isLoading}
      />

      {/* ── Body ── */}
      <div className="detail-body">
        {/* Parcel Rating */}
        <ParcelRating
          preferences={preferences}
          parcel={parcel}
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

        {/* Buildability Summary */}
        {(insightsQuery.isLoading || insights.length > 0) && (
          <div className="detail-section">
            <div className="section-title">Buildability Summary</div>
            {insightsQuery.isLoading ? (
              <LoadingSkeleton rows={4} />
            ) : (
              insights.map((insight) => <InsightCard key={insight.id} insight={insight} />)
            )}
          </div>
        )}

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
              <span className="detail-row-label">Dwelling</span>
              <span className="detail-row-value">
                {parcel.propType == null ? (
                  <span className="detail-row-muted">Unknown</span>
                ) : parcel.propType === 'Improved Property' ? (
                  <span className="detail-dwelling-yes">
                    Yes
                    {parcel.buildingValue != null && (
                      <span className="detail-dwelling-value">
                        {' '}· ${parcel.buildingValue.toLocaleString()} assessed
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="detail-dwelling-no">None on record</span>
                )}
              </span>
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

        {/* Listings */}
        {(listingsQuery.isLoading || (listingsQuery.data?.length ?? 0) > 0) && (
          <div className="detail-section">
            <div className="section-title">Listings</div>
            {listingsQuery.isLoading ? (
              <LoadingSkeleton rows={3} />
            ) : (
              listingsQuery.data!.map((listing) => <ListingCard key={listing.id} listing={listing} acreage={acreage} />)
            )}
          </div>
        )}

        {/* Is this for sale? */}
        <div className="detail-section">
          <div className="section-title">Is this for sale?</div>
          <ListingStatusSection
            status={listingStatusMutation.data ?? null}
            isPending={listingStatusMutation.isPending}
            isError={listingStatusMutation.isError}
            onCheck={() => listingStatusMutation.mutate()}
          />
        </div>

        {/* Loan Calculator */}
        <div className="detail-section">
          <div className="section-title">Loan Calculator</div>
          <LoanCalculator listingPrice={listingsQuery.data?.[0]?.price ?? listingStatusMutation.data?.price ?? null} />
        </div>

        {/* Water Rights */}
        <div className="detail-section">
          <div className="section-title">Water Rights</div>

          {waterQuery.isLoading ? (
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
            waterRights.map((waterRight) => <WaterRightCard key={waterRight.id} waterRight={waterRight} />)
          )}
        </div>

        {/* Hunting Districts */}
        <div className="detail-section">
          <div className="section-title">Hunting Districts</div>
          {huntingQuery.isLoading ? (
            <LoadingSkeleton rows={2} />
          ) : (huntingQuery.data?.length ?? 0) > 0 ? (
            <HuntingDistrictsSection districts={huntingQuery.data!} />
          ) : (
            <div className="detail-empty-note">No hunting districts overlap this parcel</div>
          )}
        </div>

        {/* Stream Gauges */}
        <div className="detail-section">
          <div className="section-title">Nearby Stream Gauges</div>
          {gaugesQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : (gaugesQuery.data?.length ?? 0) > 0 ? (
            gaugesQuery.data!.map((gauge) => <StreamGaugeCard key={gauge.id} gauge={gauge} />)
          ) : (
            <div className="detail-empty-note">No USGS gauges within 50 miles</div>
          )}
        </div>

        {/* Road & Legal Access */}
        <div className="detail-section">
          <div className="section-title">Road & Legal Access</div>
          {roadQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : roadQuery.data && !roadQuery.isError ? (
            <RoadAccessSection access={roadQuery.data} />
          ) : (
            <div className="detail-empty-note">Road access data unavailable</div>
          )}
        </div>

        {/* Utility Access */}
        <div className="detail-section">
          <div className="section-title">Utilities & Grid Access</div>
          {utilitiesQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : utilitiesQuery.data && !utilitiesQuery.isError ? (
            <UtilityAccessSection access={utilitiesQuery.data} />
          ) : (
            <div className="detail-empty-note">Utility data unavailable</div>
          )}
        </div>

        {/* Environmental */}
        <div className="detail-section">
          <div className="section-title">Environmental & Risk</div>
          {envRiskQuery.isLoading ? (
            <LoadingSkeleton rows={4} />
          ) : envRiskQuery.data && !envRiskQuery.isError ? (
            <EnvironmentalRiskSection risk={envRiskQuery.data} />
          ) : (
            <div className="detail-empty-note">Environmental data unavailable</div>
          )}
        </div>

        {/* Conservation Easements */}
        <div className="detail-section">
          <div className="section-title">Conservation Easements</div>
          {easementQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : easementQuery.data && easementQuery.data.length > 0 ? (
            <ConservationEasementSection easements={easementQuery.data} />
          ) : (
            <div className="road-access-banner road-access-ok">
              <span className="road-access-icon">✓</span>
              No conservation easements found in the NCED database
              <div className="road-access-note" style={{ marginTop: 6 }}>
                Verify with county deed records — easements may exist outside this database.
              </div>
            </div>
          )}
        </div>

        {/* Data disclaimer */}
        <div style={{ padding: '16px 20px' }}>
          <Typography variant="caption" muted>
            Data sourced from Montana DNRC, Montana Cadastral, and public listing aggregators.
            Last Best Land does not guarantee accuracy. Verify water rights, access, and encumbrances
            through county records and a licensed real estate attorney before purchase.
          </Typography>
        </div>
      </div>
    </aside>
  )
}

type RatingItem = { key: string; label: string; met: boolean | null; note: string }

function ParcelRating({
  preferences, parcel, waterRights, huntingData, gauges, roadAccess, utilities, envRisk, loading,
}: {
  preferences: Preferences
  parcel: { acreage: number | null } | null | undefined
  waterRights: WaterRight[]
  huntingData: HuntingDistrict[] | null
  gauges: StreamGauge[] | null
  roadAccess: RoadAccess | null
  utilities: UtilityAccess | null
  envRisk: EnvironmentalRisk | null
  loading: boolean
}) {
  // Normalize: stale localStorage from an old preference shape may leave fields as
  // undefined rather than null. Coerce here so all downstream checks are safe.
  const p = {
    ...preferences,
    acreageMin: preferences.acreageMin ?? null,
    acreageMax: preferences.acreageMax ?? null,
  }

  const anyEnabled =
    p.acreageMin !== null || p.acreageMax !== null ||
    p.waterRights || p.streamAccess || p.maintainedRoad || p.huntingAccess ||
    p.electricGrid || p.broadband || p.lowFloodRisk || p.lowWildfireRisk || p.noMineSites

  if (!anyEnabled) return null

  const acres = parcel?.acreage ?? null
  const activeWater = waterRights.filter((waterRight) => waterRight.status === 'active')
  const huntingSpecies = [...new Set((huntingData ?? []).map((district) => district.species))]
  const maintained = (roadAccess?.segments ?? []).filter(
    (segment) => segment.type === "highway" || segment.type === "county" || segment.type === "local"
  )
  const hasSFHA = (envRisk?.floodZones ?? []).some((zone) => zone.isSpecialFloodHazardArea)
  const floodRiskLevel = envRisk?.floodZones[0]?.riskLevel ?? null
  const wildfireRisk = envRisk?.wildfireRisk ?? null
  const mineSiteCount = envRisk?.mineSites.length ?? 0

  const items: RatingItem[] = []

  if (p.acreageMin !== null || p.acreageMax !== null) {
    const minOk = p.acreageMin === null || (acres !== null && acres >= p.acreageMin)
    const maxOk = p.acreageMax === null || (acres !== null && acres <= p.acreageMax)
    const label = p.acreageMin !== null && p.acreageMax !== null
      ? `${p.acreageMin.toLocaleString()}–${p.acreageMax.toLocaleString()} acres`
      : p.acreageMin !== null ? `At least ${p.acreageMin.toLocaleString()} acres`
      : `At most ${p.acreageMax!.toLocaleString()} acres`
    items.push({
      key: 'acreage', label,
      met: loading || acres === null ? null : minOk && maxOk,
      note: loading || acres === null ? '' : `${acres.toLocaleString()} ac`,
    })
  }
  if (p.waterRights) items.push({
    key: 'water-rights', label: 'Water rights',
    met: loading ? null : activeWater.length > 0,
    note: loading ? '' : activeWater.length > 0
      ? `${activeWater.length} active right${activeWater.length > 1 ? 's' : ''}`
      : 'None on file',
  })
  if (p.streamAccess) items.push({
    key: 'stream', label: 'Stream access',
    met: loading ? null : (gauges ?? []).length > 0,
    note: loading ? '' : (gauges ?? []).length > 0
      ? gauges![0]!.streamName ?? 'Nearby stream'
      : 'None within 50 mi',
  })
  if (p.maintainedRoad) items.push({
    key: 'road', label: 'Maintained road',
    met: loading ? null : maintained.length > 0,
    note: loading ? '' : maintained.length > 0
      ? maintained[0]!.name ?? ROAD_TYPE_LABELS[maintained[0]!.type] ?? 'Road'
      : 'None detected',
  })
  if (p.huntingAccess) items.push({
    key: 'hunting', label: 'Hunting districts',
    met: loading ? null : huntingSpecies.length > 0,
    note: loading ? '' : huntingSpecies.length > 0
      ? huntingSpecies.map((species) => species.charAt(0).toUpperCase() + species.slice(1)).join(', ')
      : 'No districts overlap',
  })
  if (p.electricGrid) {
    const elec = utilities?.electric
    const gridConnected = elec?.hasNearbyLine || elec?.serviceTerritory != null
    items.push({
      key: 'electric', label: 'Electric grid',
      met: loading ? null : gridConnected ?? false,
      note: loading ? '' : elec?.serviceTerritory
        ? elec.serviceTerritory.utilityName
        : elec?.hasNearbyLine
          ? elec.voltageClass ?? 'Transmission line nearby'
          : 'No grid service found',
    })
  }
  if (p.broadband) {
    const providers = utilities?.broadband ?? []
    // No source since the FCC retired its public lookup, so this cannot be judged met or unmet.
    const dataAvailable = utilities?.broadbandDataAvailable ?? false
    items.push({
      key: 'broadband', label: 'Broadband',
      met: loading || !dataAvailable ? null : providers.length > 0,
      note: loading ? '' : !dataAvailable ? 'No data source' : providers.length > 0
        ? providers[0]!.techType + (providers.length > 1 ? ` +${providers.length - 1}` : '')
        : 'No providers reported',
    })
  }
  if (p.lowFloodRisk) {
    const isLow = !hasSFHA && (floodRiskLevel === 'minimal' || floodRiskLevel === null)
    items.push({
      key: 'flood', label: 'Low flood risk',
      met: loading ? null : isLow,
      note: loading ? '' : hasSFHA ? 'SFHA — flood insurance required'
        : floodRiskLevel ? floodRiskLevel.charAt(0).toUpperCase() + floodRiskLevel.slice(1) + ' risk'
        : 'No flood zone overlay',
    })
  }
  if (p.lowWildfireRisk) {
    const isLow = wildfireRisk === 'Low' || wildfireRisk === 'Very Low'
    items.push({
      key: 'wildfire', label: 'Low wildfire risk',
      met: loading ? null : wildfireRisk !== null ? isLow : null,
      note: loading ? '' : wildfireRisk ?? 'No rating available',
    })
  }
  if (p.noMineSites) items.push({
    key: 'mines', label: 'No mine sites',
    met: loading ? null : mineSiteCount === 0,
    note: loading ? '' : mineSiteCount === 0
      ? 'None within 10 mi'
      : `${mineSiteCount} site${mineSiteCount > 1 ? 's' : ''} nearby`,
  })

  const scoredItems = items.filter((item) => item.met !== null)
  const metCount = scoredItems.filter((item) => item.met).length
  const total = scoredItems.length
  const pct = total > 0 ? metCount / total : 0
  const ratingLabel = pct === 1 ? 'Strong match' : pct >= 0.67 ? 'Good match' : pct >= 0.34 ? 'Partial match' : 'Low match'
  const ratingClass = pct === 1 ? 'rating-excellent' : pct >= 0.67 ? 'rating-good' : pct >= 0.34 ? 'rating-partial' : 'rating-poor'

  return (
    <div className="rating-card">
      <div className="rating-card-head">
        <span className="rating-card-title">Match Score</span>
        {!loading && total > 0 && (
          <span className={`rating-badge ${ratingClass}`}>
            {metCount}/{total}&ensp;{ratingLabel}
          </span>
        )}
        {loading && <span className="rating-badge-loading">Scoring…</span>}
      </div>

      {!loading && total > 0 && (
        <div className="rating-bar-wrap">
          <div className="rating-bar-track">
            <div className={`rating-bar-fill ${ratingClass}`} style={{ width: `${(metCount / total) * 100}%` }} />
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

function ListingCard({ listing, acreage }: { listing: Listing; acreage: number | null }) {
  const hasImage = listing.images.length > 0
  return (
    <Card className="listing-card">
      {hasImage && (
        <img
          src={listing.images[0]}
          alt="Listing photo"
          className="listing-card-image"
        />
      )}
      <CardContent className="listing-card-content">
        <div className="listing-card-head">
          <span className="listing-price">{formatPrice(listing.price)}</span>
          {listing.price && acreage && (
            <span className="listing-price-per-acre">{formatPricePerAcre(listing.price, acreage)}</span>
          )}
          <Badge variant="subtle" className="listing-source-badge">
            {getListingSourceLabel(listing.source)}
          </Badge>
        </div>
        {listing.description && (
          <Typography variant="body-sm" className="listing-description">
            {listing.description.length > 280
              ? listing.description.slice(0, 280) + '…'
              : listing.description}
          </Typography>
        )}
        <div className="listing-card-footer">
          {listing.listedAt && (
            <span className="listing-date">Listed {formatDate(listing.listedAt)}</span>
          )}
          <a
            href={listing.listingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="listing-link"
          >
            View listing →
          </a>
        </div>
      </CardContent>
    </Card>
  )
}

function ListingStatusSection({
  status,
  isPending,
  isError,
  onCheck,
}: {
  status: ListingStatus | null
  isPending: boolean
  isError: boolean
  onCheck: () => void
}) {
  if (!status && !isPending && !isError) {
    return (
      <div className="listing-status-prompt">
        <Typography variant="body-sm" className="listing-status-hint">
          We'll search the web to see if this property is currently listed for sale.
        </Typography>
        <Button variant="primary" size="sm" onClick={onCheck}>
          Check if for sale
        </Button>
      </div>
    )
  }

  if (isPending) {
    return (
      <div className="listing-status-prompt">
        <span className="spinner" />
        <Typography variant="body-sm" className="listing-status-hint">Searching the web…</Typography>
      </div>
    )
  }

  if (isError || !status) {
    return (
      <div className="listing-status-prompt">
        <Typography variant="body-sm" className="listing-status-hint">
          Could not check listing status right now.
        </Typography>
        <Button variant="ghost" size="sm" onClick={onCheck}>Try again</Button>
      </div>
    )
  }

  return (
    <div className={`listing-status-result ${status.forSale ? 'listing-status-for-sale' : 'listing-status-not-found'}`}>
      <div className="listing-status-head">
        <Badge
          variant={status.forSale ? 'default' : 'subtle'}
          className={status.forSale ? 'listing-status-badge-for-sale' : undefined}
        >
          {status.forSale ? 'For sale' : 'Not found for sale'}
        </Badge>
        {status.forSale && status.price != null && (
          <span className="listing-price">{formatPrice(status.price)}</span>
        )}
      </div>
      <Typography variant="body-sm" className="listing-status-summary">{status.summary}</Typography>
      <div className="listing-status-footer">
        {status.forSale && status.listingUrl && (
          <a href={status.listingUrl} target="_blank" rel="noopener noreferrer" className="listing-link">
            {status.source ? `View on ${status.source} →` : 'View listing →'}
          </a>
        )}
        <span className="listing-status-checked">Checked {formatDate(status.fetchedAt)}</span>
        <Button variant="ghost" size="sm" onClick={onCheck}>Refresh</Button>
      </div>
    </div>
  )
}

function WaterRightCard({ waterRight }: { waterRight: WaterRight }) {
  const statusClass = `wr-status-${waterRight.status}`
  return (
    <Card className="wr-card">
      <div className="wr-card-head">
        <code className="wr-number">{waterRight.waterRightNumber ?? 'Unknown'}</code>
        <Badge variant="subtle" className={statusClass}>
          {waterRight.status}
        </Badge>
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
        {waterRight.flowRate != null && (
          <div className="wr-field">
            <div className="wr-field-label">Flow Rate</div>
            <div className="wr-field-value">{formatFlowRate(waterRight.flowRate)}</div>
          </div>
        )}
        {waterRight.volume != null && (
          <div className="wr-field">
            <div className="wr-field-label">Volume</div>
            <div className="wr-field-value">{formatVolume(waterRight.volume)}</div>
          </div>
        )}
        {waterRight.priorityDate && (
          <div className="wr-field" style={{ gridColumn: '1 / -1' }}>
            <div className="wr-field-label">Priority Date</div>
            <div className="wr-field-value wr-priority">{formatDate(waterRight.priorityDate)}</div>
          </div>
        )}
      </div>
    </Card>
  )
}

function InsightCard({ insight }: { insight: ParcelInsight }) {
  const sentences = insight.content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

  return (
    <div className="insight-callout">
      <div className="insight-sentences">
        {sentences.map((sentence, index) => (
          <p key={index} className="insight-sentence">{sentence}</p>
        ))}
      </div>
      <div className="insight-meta">Generated {formatDate(insight.createdAt)}</div>
    </div>
  )
}

function LoadingStatus({
  parcelLoading, waterLoading, habitatLoading, accessLoading, envLoading, insightsLoading,
}: {
  parcelLoading: boolean
  waterLoading: boolean
  habitatLoading: boolean
  accessLoading: boolean
  envLoading: boolean
  insightsLoading: boolean
}) {
  let label: string | null = null
  if (parcelLoading) label = 'Loading parcel details…'
  else if (waterLoading) label = 'Fetching water rights from DNRC…'
  else if (habitatLoading) label = 'Loading habitat data…'
  else if (accessLoading) label = 'Checking road & utility access…'
  else if (envLoading) label = 'Checking environmental risks…'
  else if (insightsLoading) label = 'Generating buildability summary…'

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
  // monthlyAveragesCfs is keyed by 1-based month number, not array index.
  const monthlyFlows = Array.from({ length: 12 }, (_, monthIndex) => gauge.monthlyAveragesCfs[monthIndex + 1] ?? 0)
  const maxFlowCfs = Math.max(...monthlyFlows, 1)
  const hasMonthlyFlows = monthlyFlows.some((flowCfs) => flowCfs > 0)
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
      {hasMonthlyFlows && (
        <div className="gauge-bars">
          {monthlyFlows.map((flowCfs, monthIndex) => (
            <div key={monthIndex} className="gauge-bar-col">
              <div className="gauge-bar-track">
                <div
                  className="gauge-bar-fill"
                  style={{ height: `${Math.round((flowCfs / maxFlowCfs) * 100)}%` }}
                />
              </div>
              <div className="gauge-bar-label">{MONTH_LABELS[monthIndex]}</div>
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

const PUBLIC_ROAD_TYPES = new Set(['highway', 'county', 'local', 'forest', 'blm'])

function RoadAccessSection({ access }: { access: RoadAccess }) {
  const publicRoads = access.segments.filter((segment) => PUBLIC_ROAD_TYPES.has(segment.type))
  const roughRoads = access.segments.filter((segment) => segment.type === "trail")

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

const TECH_TYPE_ORDER = ['Fiber', 'Cable', 'Fixed Wireless', 'DSL', 'Satellite', 'Other']

function techTypeClass(tech: string): string {
  if (tech === 'Fiber') return 'broadband-fiber'
  if (tech === 'Cable') return 'broadband-cable'
  if (tech === 'Fixed Wireless') return 'broadband-wireless'
  if (tech === 'DSL') return 'broadband-dsl'
  if (tech === 'Satellite') return 'broadband-satellite'
  return 'broadband-other'
}

function UtilityAccessSection({ access }: { access: UtilityAccess }) {
  const { electric, broadband } = access

  const sortedBroadband = [...broadband].sort(
    (a, b) =>
      TECH_TYPE_ORDER.indexOf(a.techType) - TECH_TYPE_ORDER.indexOf(b.techType) ||
      (b.maxDownloadSpeed ?? 0) - (a.maxDownloadSpeed ?? 0)
  )

  return (
    <div>
      {/* Electric grid */}
      <div className="utility-subsection">
        <div className="utility-subsection-label">Electric Grid</div>
        {electric == null ? (
          <div className="detail-empty-note">Electric data unavailable</div>
        ) : (
          <>
            {electric.serviceTerritory && (
              <>
                <div className="road-access-banner road-access-ok">
                  <span className="road-access-icon">✓</span>
                  Within utility service territory
                </div>
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
                <div className={`road-access-banner road-access-ok${electric.serviceTerritory ? ' utility-secondary-banner' : ''}`}>
                  <span className="road-access-icon">✓</span>
                  Transmission line within 10 miles
                </div>
                <div className="road-list">
                  <div className="road-item">
                    <div className="road-item-left">
                      {electric.voltageClass && (
                        <span className="road-type-pill road-type-primary">{electric.voltageClass}</span>
                      )}
                      <span className="road-item-name">{electric.type ?? 'Transmission'}</span>
                    </div>
                    {electric.owner && (
                      <div className="road-item-right">
                        <span className="road-source">{electric.owner}</span>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
            {!electric.serviceTerritory && !electric.hasNearbyLine && (
              <div className="road-access-banner road-access-warn">
                <span className="road-access-icon">!</span>
                No utility service territory or transmission lines found — off-grid power likely required
              </div>
            )}
            <div className="road-access-note">
              Service territory data from EIA via HIFLD; confirms utility coverage area but not active
              service at the parcel. Contact the utility directly for a connection quote.
            </div>
          </>
        )}
      </div>

      {/* Broadband */}
      <div className="utility-subsection" style={{ marginTop: 14 }}>
        <div className="utility-subsection-label">Broadband Availability</div>
        {!access.broadbandDataAvailable ? (
          <div className="road-access-banner road-access-warn">
            <span className="road-access-icon">!</span>
            Broadband availability is unavailable — the FCC retired the public lookup this used
          </div>
        ) : sortedBroadband.length === 0 ? (
          <div className="road-access-banner road-access-warn">
            <span className="road-access-icon">!</span>
            No broadband providers reported at this location
          </div>
        ) : (
          <div className="road-list">
            {sortedBroadband.map((provider, index) => (
              <BroadbandProviderRow key={index} provider={provider} />
            ))}
          </div>
        )}
        {access.broadbandDataAvailable && (
          <div className="road-access-note">
            FCC broadband data reflects provider filings and may not match actual service at this address.
          </div>
        )}
      </div>
    </div>
  )
}

function BroadbandProviderRow({ provider }: { provider: BroadbandProvider }) {
  const dl = provider.maxDownloadSpeed
  const ul = provider.maxUploadSpeed
  const speedLabel = dl != null
    ? `${dl >= 1000 ? `${dl / 1000} Gbps` : `${dl} Mbps`} ↓${ul != null ? ` / ${ul >= 1000 ? `${ul / 1000} Gbps` : `${ul} Mbps`} ↑` : ''}`
    : null

  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className={`road-type-pill ${techTypeClass(provider.techType)}`}>
          {provider.techType}
        </span>
        <span className="road-item-name">{provider.providerName}</span>
      </div>
      {speedLabel && (
        <div className="road-item-right">
          <span className="road-source">{speedLabel}</span>
        </div>
      )}
    </div>
  )
}

const FLOOD_RISK_LABELS: Record<string, string> = {
  high: 'High Flood Risk',
  moderate: 'Moderate Flood Risk',
  minimal: 'Minimal Flood Risk',
  undetermined: 'Undetermined Flood Zone',
}

const FLOOD_RISK_CLASS: Record<string, string> = {
  high: 'road-access-warn',
  moderate: 'road-access-warn',
  minimal: 'road-access-ok',
  undetermined: '',
}

const FLOOD_RISK_ICON: Record<string, string> = {
  high: '!',
  moderate: '!',
  minimal: '✓',
  undetermined: '?',
}

const WILDFIRE_RISK_CLASS: Record<WildfireRiskRating, string> = {
  'Very High': 'wr-status-unknown',
  'High': 'wr-status-unknown',
  'Medium': 'broadband-dsl',
  'Low': 'broadband-fiber',
  'Very Low': 'broadband-fiber',
}

function FloodZoneRow({ zone }: { zone: FloodZone }) {
  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className={`road-type-pill ${zone.riskLevel === 'high' ? 'road-type-rough' : zone.riskLevel === 'moderate' ? 'road-type-secondary' : 'road-type-primary'}`}>
          Zone {zone.zone}
        </span>
        {zone.subtype && <span className="road-item-name">{zone.subtype}</span>}
      </div>
      <div className="road-item-right">
        {zone.isSpecialFloodHazardArea && (
          <span className="road-surface">SFHA</span>
        )}
        <span className="road-source">{FLOOD_RISK_LABELS[zone.riskLevel]}</span>
      </div>
    </div>
  )
}

function EnvironmentalRiskSection({ risk }: { risk: EnvironmentalRisk }) {
  const { floodZones, wildfireRisk, mineSites } = risk

  const worstFlood = floodZones[0] ?? null
  const hasSFHA = floodZones.some((zone) => zone.isSpecialFloodHazardArea)

  return (
    <div>
      {/* Flood Zone */}
      <div className="utility-subsection">
        <div className="utility-subsection-label">Flood Zone</div>
        {floodZones.length === 0 ? (
          <div className="road-access-banner road-access-ok">
            <span className="road-access-icon">✓</span>
            No FEMA flood zone overlay at this parcel
          </div>
        ) : (
          <>
            {worstFlood && (
              <div className={`road-access-banner ${FLOOD_RISK_CLASS[worstFlood.riskLevel] ?? ''}`}>
                <span className="road-access-icon">{FLOOD_RISK_ICON[worstFlood.riskLevel]}</span>
                {hasSFHA
                  ? 'Special Flood Hazard Area — federal flood insurance may be required'
                  : FLOOD_RISK_LABELS[worstFlood.riskLevel]}
              </div>
            )}
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

      {/* Wildfire Risk */}
      <div className="utility-subsection" style={{ marginTop: 14 }}>
        <div className="utility-subsection-label">Wildfire Risk</div>
        {wildfireRisk == null ? (
          <div className="detail-empty-note">No wildfire risk rating available for this area</div>
        ) : (
          <div className="detail-row">
            <span className="detail-row-label">FEMA NRI Rating</span>
            <span className="detail-row-value">
              <Badge variant="subtle" className={`road-type-pill ${WILDFIRE_RISK_CLASS[wildfireRisk]}`}>
                {wildfireRisk}
              </Badge>
            </span>
          </div>
        )}
        <div className="road-access-note" style={{ marginTop: 6 }}>
          Based on FEMA National Risk Index census-tract data. High-risk areas may affect insurance
          availability and defensible-space requirements.
        </div>
      </div>

      {/* Mine Sites */}
      <div className="utility-subsection" style={{ marginTop: 14 }}>
        <div className="utility-subsection-label">Nearby Mine Sites</div>
        {mineSites.length === 0 ? (
          <div className="detail-empty-note">No USGS-recorded mine sites within 10 miles</div>
        ) : (
          <div className="road-list">
            {mineSites.map((mineSite, index) => <MineSiteRow key={index} mine={mineSite} />)}
          </div>
        )}
        <div className="road-access-note" style={{ marginTop: 6 }}>
          USGS Mineral Resources Data System. Proximity to mines may indicate contamination risk —
          consult Phase I/II environmental assessment before purchase.
        </div>
      </div>
    </div>
  )
}

function MineSiteRow({ mine }: { mine: MineSite }) {
  const label = mine.devStatus ?? 'Mine Site'
  return (
    <div className="road-item">
      <div className="road-item-left">
        <span className="road-type-pill road-type-rough">{label}</span>
        <span className="road-item-name">{mine.name ?? 'Unnamed Site'}</span>
      </div>
      {mine.commodities && (
        <div className="road-item-right">
          <span className="road-source">{mine.commodities}</span>
        </div>
      )}
    </div>
  )
}

function LoanCalculator({ listingPrice }: { listingPrice: number | null }) {
  const [purchasePrice, setPurchasePrice] = useState<string>(
    listingPrice != null ? String(Math.round(listingPrice)) : ''
  )
  const [downPct, setDownPct] = useState('20')
  const [rate, setRate] = useState('8.5')
  const [termYears, setTermYears] = useState('15')

  useEffect(() => {
    if (listingPrice != null && purchasePrice === '') {
      setPurchasePrice(String(Math.round(listingPrice)))
    }
  }, [listingPrice])

  const price = parseFloat(purchasePrice) || 0
  const down = Math.min(Math.max(parseFloat(downPct) || 0, 0), 100)
  const annualRate = parseFloat(rate) || 0
  const years = parseInt(termYears) || 0
  const loanAmount = price * (1 - down / 100)
  const monthlyRate = annualRate / 100 / 12
  const n = years * 12
  const monthly =
    loanAmount > 0 && monthlyRate > 0 && n > 0
      ? loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, n)) / (Math.pow(1 + monthlyRate, n) - 1)
      : 0

  return (
    <div>
      <div className="detail-row">
        <span className="detail-row-label">Purchase price</span>
        <span className="detail-row-value">
          <input
            type="number"
            className="loan-input"
            value={purchasePrice}
            min={0}
            placeholder="Enter price"
            onChange={(changeEvent) => setPurchasePrice(changeEvent.target.value)}
          />
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-row-label">Down payment</span>
        <span className="detail-row-value">
          <input
            type="number"
            className="loan-input loan-input-sm"
            value={downPct}
            min={0} max={100}
            onChange={(changeEvent) => setDownPct(changeEvent.target.value)}
          />
          <span className="loan-input-suffix">%</span>
          {price > 0 && (
            <span className="loan-input-computed">
              {' '}= ${Math.round(price * (parseFloat(downPct) || 0) / 100).toLocaleString()}
            </span>
          )}
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-row-label">Interest rate</span>
        <span className="detail-row-value">
          <input
            type="number"
            className="loan-input loan-input-sm"
            value={rate}
            min={0} max={30} step={0.1}
            onChange={(changeEvent) => setRate(changeEvent.target.value)}
          />
          <span className="loan-input-suffix">% / yr</span>
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-row-label">Loan term</span>
        <span className="detail-row-value">
          <input
            type="number"
            className="loan-input loan-input-sm"
            value={termYears}
            min={1} max={30}
            onChange={(changeEvent) => setTermYears(changeEvent.target.value)}
          />
          <span className="loan-input-suffix">years</span>
        </span>
      </div>
      {monthly > 0 && (
        <div className="loan-result">
          <span className="loan-result-label">Est. monthly P&amp;I</span>
          <span className="loan-result-amount">${Math.round(monthly).toLocaleString()}/mo</span>
        </div>
      )}
      <div className="loan-note">
        Land loans typically carry higher rates (7–11%) and shorter terms than residential
        mortgages. Consult a lender for an accurate quote.
      </div>
    </div>
  )
}

function ConservationEasementSection({ easements }: { easements: ConservationEasement[] }) {
  return (
    <div>
      <div className="road-access-banner road-access-warn">
        <span className="road-access-icon">!</span>
        {easements.length} conservation easement{easements.length > 1 ? 's' : ''} found — development restrictions may apply
      </div>
      <div className="road-list">
        {easements.map((easement, index) => (
          <div key={index} className="easement-card">
            <div className="easement-holder">{easement.holderName ?? 'Unknown holder'}</div>
            {easement.purpose && <div className="easement-field"><span className="easement-field-label">Purpose</span> {easement.purpose}</div>}
            {easement.restrictions && <div className="easement-field"><span className="easement-field-label">Restrictions</span> {easement.restrictions}</div>}
            <div className="easement-meta">
              {easement.acreage != null && <span>{easement.acreage.toLocaleString()} ac</span>}
              {easement.dateRecorded && <span>Recorded {formatDate(easement.dateRecorded)}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="road-access-note">
        Source: National Conservation Easement Database (NCED). Verify restrictions with a
        real estate attorney — easement terms vary and affect building, subdivision, and use.
      </div>
    </div>
  )
}

