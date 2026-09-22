import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { Parcel, ParcelCandidate, ParcelCandidates } from '@lastbestland/shared';
import { parsePriorityDate, parseWaterRightStatus, parseWaterType } from '@lastbestland/shared';
import { query, execute } from '../shared/db';
import { env } from '../shared/env';
import { fetchJson, isTimeoutError } from '../shared/http';
import { queryArcGis, arcGisLiteral, pointGeometryParams, polygonGeometryParams, type ArcGisFeature } from '../shared/arcgis';
import { parcelColumns, toParcel, type ParcelRow } from '../shared/parcels';
import { success, badRequest, serverError, serviceUnavailable } from '../shared/response';
import { getOrCheckListingStatus } from '../shared/listingStatus';
import { invalidateCachedParcel } from '../shared/parcelCache';
import { logger } from '../shared/logger';
import {
  addressVariants,
  cityPart,
  hasNoHouseNumber,
  lotNumberAsHouseNumber,
  parseAddressParts,
  parseStreetNumber,
  roadName,
  streetPart,
} from './address';

// Montana State Library cadastral parcels and E911 address points.
const CADASTRAL_URL = 'https://gisservice.mt.gov/arcgis/rest/services/msdi_cadastral_map_v1/MapServer/1/query';
const ADDRESS_POINTS_URL = 'https://gisservice.mt.gov/arcgis/rest/services/msdi_structures_addresses_map_v1/MapServer/0/query';
// DNRC Water Right Query System. Layer 6 links rights to parcel geocodes, layer 2 holds place-of-use polygons.
const WRQS_GEOCODE_URL = 'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query';
const WRQS_PLACE_OF_USE_URL = 'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/2/query';
const CENSUS_ONELINE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_STRUCTURED_URL = 'https://geocoding.geo.census.gov/geocoder/locations/address';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

const GIS_TIMEOUT_MS = 25_000;
const CADASTRAL_FIELDS = 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType,Subdivision,TotalValue';
const CANDIDATE_LIMIT = 50;
// Each listing check is a web search plus a model call, so only the first few candidates are checked.
const LISTING_CHECK_CANDIDATE_CAP = 10;

interface CadastralAttributes {
  PARCELID: string;
  CountyName: string | null;
  AddressLine1: string | null;
  CityStateZip: string | null;
  TotalAcres: number | null;
  GISAcres: number | null;
  TotalBuildingValue: number | null;
  PropType: string | null;
  Subdivision: string | null;
  TotalValue: number | null;
}

type CadastralFeature = ArcGisFeature<CadastralAttributes>;

interface LatLng {
  lat: number;
  lng: number;
}

function likeAnyVariant(field: string, value: string): string {
  return addressVariants(value)
    .map((variant) => `UPPER(${field}) LIKE UPPER('%${arcGisLiteral(variant)}%')`)
    .join(' OR ');
}

function queryCadastral(params: Record<string, string>): Promise<CadastralFeature[]> {
  return queryArcGis<CadastralAttributes>(
    CADASTRAL_URL,
    { outFields: CADASTRAL_FIELDS, returnGeometry: 'true', outSR: '4326', ...params },
    GIS_TIMEOUT_MS
  );
}

async function firstCadastral(params: Record<string, string>): Promise<CadastralFeature | null> {
  const features = await queryCadastral({ ...params, resultRecordCount: '1' });
  return features[0] ?? null;
}

function cadastralById(parcelId: string): Promise<CadastralFeature | null> {
  return firstCadastral({ where: `PARCELID = '${arcGisLiteral(parcelId)}'` });
}

function cadastralByAddressOrId(q: string): Promise<CadastralFeature | null> {
  return firstCadastral({
    where: `(${likeAnyVariant('AddressLine1', streetPart(q))}) OR UPPER(PARCELID) LIKE UPPER('%${arcGisLiteral(q)}%')`,
  });
}

function cadastralByPoint(point: LatLng): Promise<CadastralFeature | null> {
  return firstCadastral(pointGeometryParams(point.lat, point.lng));
}

function cadastralOnRoad(road: string): Promise<CadastralFeature[]> {
  return queryCadastral({
    where: likeAnyVariant('AddressLine1', road),
    resultRecordCount: String(CANDIDATE_LIMIT),
    orderByFields: 'TotalAcres DESC',
  });
}

async function cadastralByAddressPoint(q: string): Promise<CadastralFeature | null> {
  const parsed = parseStreetNumber(streetPart(q));
  if (!parsed) return null;
  const city = arcGisLiteral(cityPart(q));
  const cityClause = city ? ` AND UPPER(Post_Comm) LIKE UPPER('%${city}%')` : '';
  const features = await queryArcGis<{ ParcelID?: string | null }>(
    ADDRESS_POINTS_URL,
    {
      where: `Add_Number = ${parsed.number} AND (${likeAnyVariant('St_Name', parsed.name)})${cityClause}`,
      outFields: 'ParcelID',
      resultRecordCount: '1',
    },
    GIS_TIMEOUT_MS
  );
  const parcelId = features[0]?.attributes.ParcelID;
  return parcelId ? cadastralById(parcelId) : null;
}

interface CensusGeocodeResponse {
  result?: { addressMatches?: Array<{ coordinates?: { x: number; y: number } }> };
}

async function censusGeocode(url: string, params: Record<string, string>): Promise<LatLng | null> {
  const search = new URLSearchParams({ ...params, benchmark: 'Public_AR_Current', format: 'json' });
  const data = await fetchJson<CensusGeocodeResponse>(`${url}?${search}`, {}, GIS_TIMEOUT_MS);
  const coords = data.result?.addressMatches?.[0]?.coordinates;
  return coords ? { lat: coords.y, lng: coords.x } : null;
}

function censusOneline(q: string): Promise<LatLng | null> {
  return censusGeocode(CENSUS_ONELINE_URL, { address: q });
}

function censusStructured(q: string): Promise<LatLng | null> {
  const parts = parseAddressParts(q);
  if (!parts) return Promise.resolve(null);
  return censusGeocode(CENSUS_STRUCTURED_URL, {
    street: parts.street,
    city: parts.city,
    state: parts.state,
    ...(parts.zip ? { zip: parts.zip } : {}),
  });
}

async function nominatim(q: string): Promise<LatLng | null> {
  const search = new URLSearchParams({ q, format: 'json', limit: '1', countrycodes: 'us' });
  const data = await fetchJson<Array<{ lat: string; lon: string }>>(
    `${NOMINATIM_URL}?${search}`,
    { headers: { 'User-Agent': `landfinder/1.0 (${env.geocoderContactEmail})` } },
    10_000
  );
  const first = data[0];
  return first ? { lat: Number.parseFloat(first.lat), lng: Number.parseFloat(first.lon) } : null;
}

// Most authoritative first. Each failure is logged and the next geocoder tried.
const GEOCODERS: Array<[string, (q: string) => Promise<LatLng | null>]> = [
  ['census', censusOneline],
  ['census-structured', censusStructured],
  ['nominatim', nominatim],
];

async function geocode(q: string): Promise<LatLng | null> {
  for (const [name, geocoder] of GEOCODERS) {
    try {
      const point = await geocoder(q);
      if (point) return point;
    } catch (err) {
      logger.warn('Geocoder failed', { geocoder: name, error: String(err) });
    }
  }
  return null;
}

type Resolution =
  | { kind: 'parcel'; feature: CadastralFeature }
  | { kind: 'candidates'; features: CadastralFeature[]; road: string }
  | null;

async function candidatesOnRoad(road: string): Promise<Resolution> {
  const features = await cadastralOnRoad(road);
  if (features.length > 1) return { kind: 'candidates', features, road };
  if (features.length === 1) return { kind: 'parcel', feature: features[0]! };
  return null;
}

/**
 * Resolves a query to a parcel or a list of candidates by trying, in order:
 * road-name search for addresses without a house number, cadastral match on
 * address or parcel ID, the E911 address point layer, geocoding followed by a
 * point-in-polygon query, and finally a road-name search as a fallback.
 */
async function resolve(q: string): Promise<Resolution> {
  if (hasNoHouseNumber(q)) {
    const road = roadName(q);
    const resolution = road ? await candidatesOnRoad(road) : null;
    if (resolution) return resolution;
  }

  let feature = await cadastralByAddressOrId(q);
  feature ??= await cadastralByAddressPoint(q);
  if (!feature) {
    const point = await geocode(q);
    if (point) feature = await cadastralByPoint(point);
  }
  if (feature) return { kind: 'parcel', feature };

  const road = roadName(q);
  return road ? candidatesOnRoad(road) : null;
}

function formatAddress(attributes: CadastralAttributes): string | null {
  if (!attributes.AddressLine1) return null;
  const city = attributes.CityStateZip?.trim();
  return `${attributes.AddressLine1.trim()}${city ? `, ${city}` : ''}`;
}

function toCandidate(feature: CadastralFeature): ParcelCandidate {
  const { attributes } = feature;
  return {
    parcelId: attributes.PARCELID,
    address: formatAddress(attributes),
    acreage: attributes.TotalAcres ?? attributes.GISAcres ?? null,
    county: attributes.CountyName,
    subdivision: attributes.Subdivision,
    totalValue: attributes.TotalValue,
    forSale: null,
    listingSummary: null,
  };
}

async function toCandidates(features: CadastralFeature[], road: string): Promise<ParcelCandidates> {
  const candidates = features.map(toCandidate);
  const checks = await Promise.all(
    candidates.slice(0, LISTING_CHECK_CANDIDATE_CAP).map((candidate) =>
      candidate.address ? getOrCheckListingStatus(candidate.parcelId, candidate.address) : null
    )
  );
  const enriched = candidates.map((candidate, i) => {
    const status = checks[i];
    return status ? { ...candidate, forSale: status.forSale, listingSummary: status.summary } : candidate;
  });
  // Parcels that are for sale lead, without hiding how many matched.
  return {
    candidates: [...enriched.filter((c) => c.forSale), ...enriched.filter((c) => !c.forSale)],
    roadName: road,
  };
}

// The point is the centroid of the boundary when one is available. The upsert
// keeps an existing point or boundary if the new record lacks one.
async function upsertParcel(feature: CadastralFeature): Promise<ParcelRow> {
  const { attributes, geometry } = feature;
  const boundary = geometry?.rings ? JSON.stringify({ type: 'Polygon', coordinates: geometry.rings }) : null;
  const rows = await query<ParcelRow>(
    `INSERT INTO parcels (state, county, parcel_number, geo_id, address, acreage, building_value, prop_type, boundary, coordinates)
     SELECT 'MT', $1, $2, $2, $3, $4, $5, $6, b.geom, ST_Centroid(b.geom::geometry)::geography
     FROM (SELECT ST_GeomFromGeoJSON($7)::geography AS geom) b
     ON CONFLICT (state, parcel_number) DO UPDATE SET
       county = EXCLUDED.county,
       address = EXCLUDED.address,
       acreage = EXCLUDED.acreage,
       building_value = EXCLUDED.building_value,
       prop_type = EXCLUDED.prop_type,
       coordinates = COALESCE(EXCLUDED.coordinates, parcels.coordinates),
       boundary = COALESCE(EXCLUDED.boundary, parcels.boundary),
       updated_at = NOW()
     RETURNING ${parcelColumns()}`,
    [
      attributes.CountyName || null,
      attributes.PARCELID,
      formatAddress(attributes),
      attributes.TotalAcres ?? attributes.GISAcres ?? null,
      attributes.TotalBuildingValue ?? null,
      attributes.PropType ?? null,
      boundary,
    ]
  );
  if (!rows[0]) throw new Error('No row returned from parcel upsert');
  // The upsert just replaced the cadastral fields, so the cached copy is stale.
  // Dropped rather than rewritten: the next read repopulates from Postgres, and
  // a failed delete only costs a stale read for the rest of the record's TTL.
  await invalidateCachedParcel(rows[0].id);
  return rows[0];
}

interface WaterRightRecord {
  number: string;
  source: string | null;
  type: string;
  flowRateGpm: number | null;
  volume: number | null;
  priorityDate: string | null;
  status: string;
  rawData: Record<string, unknown>;
}

type WrqsFeature = ArcGisFeature<Record<string, unknown>>;

function fromGeocodeLayer(attributes: Record<string, unknown>): WaterRightRecord {
  return {
    number: String(attributes.WR_NUMBER),
    source: (attributes.SOURCE_NAMES as string | null) ?? null,
    type: parseWaterType(attributes.SOURCE_TYPES),
    flowRateGpm: (attributes.MAX_FLOW_GPM as number | null) ?? null,
    volume: (attributes.MAX_VOL as number | null) ?? null,
    priorityDate: parsePriorityDate(attributes.ENF_PRTY_DT_DATE, null),
    status: parseWaterRightStatus(attributes.WR_STATUS),
    rawData: { source: 'dnrc_geocode', geocd: attributes.GEOCD ?? null },
  };
}

function placeOfUseMetadata(attributes: Record<string, unknown>): Record<string, unknown> {
  return {
    owners: attributes.OWNERS ?? null,
    purpose: attributes.PURPOSE ?? null,
    abstractUrl: attributes.URL_ABSTRACT ?? null,
    geocodes: attributes.GEOCODES ?? null,
  };
}

function fromPlaceOfUseLayer(attributes: Record<string, unknown>): WaterRightRecord {
  return {
    number: String(attributes.WR_NUMBER),
    // The source name lives on the point-of-diversion layer, which is not queried.
    source: null,
    type: 'surface',
    flowRateGpm: (attributes.MAX_FLOW_GPM as number | null) ?? null,
    volume: (attributes.MAX_VOL as number | null) ?? null,
    priorityDate: parsePriorityDate(attributes.ENF_PRTY_DT_DATE, attributes.ENF_PRTY_DT_CHAR),
    status: parseWaterRightStatus(attributes.WR_STATUS),
    rawData: { source: 'dnrc_place_of_use', ...placeOfUseMetadata(attributes) },
  };
}

/** Merges the two layers by right number. The geocode layer wins because it carries the source name and type. */
export function mergeWaterRights(geocodeFeatures: WrqsFeature[], placeOfUseFeatures: WrqsFeature[]): WaterRightRecord[] {
  const byNumber = new Map<string, WaterRightRecord>();
  for (const { attributes } of geocodeFeatures) {
    if (attributes.WR_NUMBER) byNumber.set(String(attributes.WR_NUMBER), fromGeocodeLayer(attributes));
  }
  for (const { attributes } of placeOfUseFeatures) {
    if (!attributes.WR_NUMBER) continue;
    const number = String(attributes.WR_NUMBER);
    const existing = byNumber.get(number);
    if (existing) {
      existing.rawData = { ...existing.rawData, source: 'dnrc_both', ...placeOfUseMetadata(attributes) };
    } else {
      byNumber.set(number, fromPlaceOfUseLayer(attributes));
    }
  }
  return [...byNumber.values()];
}

async function seedWaterRights(parcel: ParcelRow): Promise<void> {
  if (!parcel.parcel_number) return;
  const geometry = parcel.boundary
    ? polygonGeometryParams((JSON.parse(parcel.boundary) as { coordinates: number[][][] }).coordinates)
    : parcel.latitude !== null && parcel.longitude !== null
      ? { ...pointGeometryParams(parcel.latitude, parcel.longitude), distance: '0.1', units: 'esriSRUnit_StatuteMile' }
      : null;

  const [geocodeFeatures, placeOfUseFeatures] = await Promise.all([
    queryArcGis(WRQS_GEOCODE_URL, {
      where: `GEOCD = '${arcGisLiteral(parcel.parcel_number)}'`,
      outFields: 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_VOL,GEOCD',
      resultRecordCount: '100',
    }, GIS_TIMEOUT_MS),
    geometry
      ? queryArcGis(WRQS_PLACE_OF_USE_URL, {
          ...geometry,
          where: '1=1',
          outFields: 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,ENF_PRTY_DT_CHAR,OWNERS,PURPOSE,MAX_FLOW_GPM,MAX_FLOW_CFS,MAX_VOL,GEOCODES,URL_ABSTRACT',
          resultRecordCount: '100',
        }, GIS_TIMEOUT_MS)
      : Promise.resolve([]),
  ]);

  const rights = mergeWaterRights(geocodeFeatures, placeOfUseFeatures);
  logger.info('WRQS results', { parcelId: parcel.id, geocode: geocodeFeatures.length, placeOfUse: placeOfUseFeatures.length });
  if (rights.length === 0) return;

  const fetchedAt = new Date().toISOString();
  await execute(
    `INSERT INTO water_rights
       (parcel_id, water_right_number, water_source, water_type, flow_rate, volume, priority_date, status, raw_data)
     SELECT $1::uuid, unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::numeric[]),
            unnest($6::numeric[]), unnest($7::date[]), unnest($8::text[]), unnest($9::jsonb[])
     ON CONFLICT (parcel_id, water_right_number) DO UPDATE SET
       water_source  = COALESCE(EXCLUDED.water_source, water_rights.water_source),
       flow_rate     = COALESCE(EXCLUDED.flow_rate, water_rights.flow_rate),
       volume        = COALESCE(EXCLUDED.volume, water_rights.volume),
       priority_date = COALESCE(EXCLUDED.priority_date, water_rights.priority_date),
       status        = EXCLUDED.status,
       raw_data      = water_rights.raw_data || EXCLUDED.raw_data`,
    [
      parcel.id,
      rights.map((r) => r.number),
      rights.map((r) => r.source),
      rights.map((r) => r.type),
      rights.map((r) => r.flowRateGpm),
      rights.map((r) => r.volume),
      rights.map((r) => r.priorityDate),
      rights.map((r) => r.status),
      rights.map((r) => JSON.stringify({ ...r.rawData, fetchedAt })),
    ]
  );
}

async function persist(feature: CadastralFeature): Promise<Parcel> {
  const row = await upsertParcel(feature);
  try {
    await seedWaterRights(row);
  } catch (err) {
    logger.warn('Water rights seed failed', { parcelId: row.id, error: String(err) });
  }
  return toParcel(row);
}

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const rawQuery = event.queryStringParameters?.q?.trim();
    if (!rawQuery || rawQuery.length < 3) return badRequest('Query parameter "q" is required (minimum 3 characters)');

    // Start an Aurora resume now, in parallel with the GIS calls. The upsert
    // has its own resume retries if this has not finished.
    void query('SELECT 1').catch(() => undefined);

    const q = lotNumberAsHouseNumber(rawQuery) ?? rawQuery;
    const resolution = await resolve(q);
    if (!resolution) return success(null);
    if (resolution.kind === 'candidates') {
      logger.info('Lookup returned candidates', { q, road: resolution.road, count: resolution.features.length });
      return success(await toCandidates(resolution.features, resolution.road));
    }
    return success(await persist(resolution.feature));
  } catch (err) {
    logger.error('Parcel lookup error', { error: String(err) });
    if (isTimeoutError(err)) return serviceUnavailable('The parcel lookup service is temporarily slow. Please try again.');
    return serverError('An error occurred during parcel lookup');
  }
}
