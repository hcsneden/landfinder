import type { EnvironmentalRisk, FloodRiskLevel, FloodZone, MineSite, WildfireRiskRating } from '@lastbestland/shared';
import {
  queryArcGis,
  polygonGeometryParams,
  pointGeometryParams,
  envelopeGeometryParams,
  stringAttribute,
} from '../../shared/arcgis';
import { withParcelCache, parcelSearchArea, days } from '../../shared/parcelCache';
import { logger } from '../../shared/logger';

const TTL_MS = days(30);
const FLOOD_BOUNDARY_BUFFER_METERS = 50;
const FLOOD_POINT_BUFFER_METERS = 200;
const MINE_SEARCH_RADIUS_METERS = 16_093; // 10 miles

// FEMA National Flood Hazard Layer, flood hazard zones (S_Fld_Haz_Ar).
const FEMA_NFHL_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
// FEMA National Risk Index, census tract scores.
const FEMA_NRI_URL = 'https://services.arcgis.com/XG15caxAWkAJOxhH/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0/query';
// USGS Mineral Resources Data System, compact hosted service.
const USGS_MRDS_URL = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer/0/query';

const WILDFIRE_RATINGS: ReadonlySet<string> = new Set<WildfireRiskRating>(['Very High', 'High', 'Medium', 'Low', 'Very Low']);
const RISK_ORDER: FloodRiskLevel[] = ['high', 'moderate', 'undetermined', 'minimal'];

export function classifyFloodZone(zone: string): FloodRiskLevel {
  const code = zone.trim().toUpperCase();
  if (code === 'X' || code === 'C') return 'minimal';
  if (code === 'B' || code === 'X500') return 'moderate';
  if (code === 'D') return 'undetermined';
  // A and V zones, including AE, AO, VE, are special flood hazard areas.
  if (code.startsWith('A') || code.startsWith('V')) return 'high';
  return 'undetermined';
}

interface FloodAttributes {
  FLD_ZONE?: string | null;
  ZONE_SUBTY?: string | null;
  SFHA_TF?: string | null;
}

async function fetchFloodZones(rings: number[][][]): Promise<FloodZone[]> {
  const features = await queryArcGis<FloodAttributes>(FEMA_NFHL_URL, {
    ...polygonGeometryParams(rings),
    outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
    resultRecordCount: '20',
    returnGeometry: 'false',
  });
  const seen = new Set<string>();
  const zones: FloodZone[] = [];
  for (const { attributes } of features) {
    const zone = stringAttribute(attributes.FLD_ZONE) ?? 'UNKNOWN';
    const subtype = stringAttribute(attributes.ZONE_SUBTY);
    const key = `${zone}:${subtype ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push({
      zone,
      subtype,
      isSpecialFloodHazardArea: String(attributes.SFHA_TF ?? '').toUpperCase() === 'T',
      riskLevel: classifyFloodZone(zone),
    });
  }
  return zones.sort((a, b) => RISK_ORDER.indexOf(a.riskLevel) - RISK_ORDER.indexOf(b.riskLevel));
}

async function fetchWildfireRisk(lat: number, lon: number): Promise<WildfireRiskRating | null> {
  const features = await queryArcGis(FEMA_NRI_URL, {
    ...pointGeometryParams(lat, lon),
    spatialRel: 'esriSpatialRelWithin',
    outFields: 'WFIR_RISKR',
    resultRecordCount: '1',
    returnGeometry: 'false',
  });
  const rating = stringAttribute(features[0]?.attributes.WFIR_RISKR);
  return rating && WILDFIRE_RATINGS.has(rating) ? (rating as WildfireRiskRating) : null;
}

async function fetchMineSites(rings: number[][][]): Promise<MineSite[]> {
  // An envelope rather than the buffered polygon, and no resultRecordCount:
  // this service takes 8 to 12 seconds for a polygon query and well under a
  // second for a plain envelope. The extra corner area is acceptable for a
  // proximity signal.
  const features = await queryArcGis(USGS_MRDS_URL, {
    ...envelopeGeometryParams(rings),
    outFields: 'SITE_NAME,DEV_STAT,CODE_LIST,URL',
    returnGeometry: 'false',
  });
  return features.slice(0, 20).map(({ attributes }) => ({
    name: stringAttribute(attributes.SITE_NAME),
    devStatus: stringAttribute(attributes.DEV_STAT),
    commodities: stringAttribute(attributes.CODE_LIST),
    url: stringAttribute(attributes.URL),
  }));
}

type RiskPayload = Omit<EnvironmentalRisk, 'parcelId' | 'fetchedAt'>;

async function fetchEnvironmentalRisk(parcelId: string): Promise<RiskPayload> {
  const [floodArea, mineArea] = await Promise.all([
    parcelSearchArea(parcelId, FLOOD_BOUNDARY_BUFFER_METERS, FLOOD_POINT_BUFFER_METERS),
    parcelSearchArea(parcelId, MINE_SEARCH_RADIUS_METERS, MINE_SEARCH_RADIUS_METERS),
  ]);
  if (!floodArea || !mineArea) throw new Error('Parcel has no location');

  const [flood, wildfire, mines] = await Promise.allSettled([
    fetchFloodZones(floodArea.rings),
    fetchWildfireRisk(floodArea.lat, floodArea.lon),
    fetchMineSites(mineArea.rings),
  ]);
  if (flood.status === 'rejected') logger.warn('FEMA NFHL flood query failed', { error: String(flood.reason) });
  if (wildfire.status === 'rejected') logger.warn('FEMA NRI wildfire query failed', { error: String(wildfire.reason) });
  if (mines.status === 'rejected') logger.warn('USGS MRDS mine query failed', { error: String(mines.reason) });
  if ([flood, wildfire, mines].every((result) => result.status === 'rejected')) {
    throw new Error('All environmental sources failed');
  }

  return {
    floodZones: flood.status === 'fulfilled' ? flood.value : [],
    wildfireRisk: wildfire.status === 'fulfilled' ? wildfire.value : null,
    mineSites: mines.status === 'fulfilled' ? mines.value : [],
  };
}

export async function getEnvironmentalRisk(parcelId: string, forceRefresh: boolean): Promise<EnvironmentalRisk | null> {
  const cached = await withParcelCache('environmental_risk', parcelId, TTL_MS, forceRefresh, () => fetchEnvironmentalRisk(parcelId));
  if (!cached) return null;
  return { parcelId, ...cached.payload, fetchedAt: cached.fetchedAt };
}
