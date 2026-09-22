import https from 'https';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { query, execute } from '../shared/db';
import { success, badRequest, serverError, error as errorResponse } from '../shared/response';
import { getOrCheckListingStatus } from '../shared/listingStatus';
import { logger } from '../shared/logger';
import type { Parcel, ParcelCandidate } from '@lastbestland/shared';

const CADASTRAL_URL =
  'https://gisservice.mt.gov/arcgis/rest/services/msdi_cadastral_map_v1/MapServer/1/query';
// Layer 6: Geocodes — exact parcel-geocode linkage
const DNRC_WRQS_GEOCODE_URL =
  'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query';
// Layer 2: Places of Use — geographic polygons of where water rights are applied
const DNRC_WRQS_POU_URL =
  'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/2/query';
const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_GEOCODER_STRUCTURED_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/address';
// Montana E911 address points — has house-number-level records with direct ParcelID links
const MSDI_ADDRESS_URL =
  'https://gisservice.mt.gov/arcgis/rest/services/msdi_structures_addresses_map_v1/MapServer/0/query';
const TIMEOUT_MS = 25_000;

const WRQS_GEOCODE_FIELDS = 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_VOL,GEOCD';
const WRQS_POU_FIELDS = 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,ENF_PRTY_DT_CHAR,OWNERS,PURPOSE,MAX_FLOW_GPM,MAX_FLOW_CFS,MAX_VOL,GEOCODES,URL_ABSTRACT';

// Montana state GIS servers use intermediate CAs not in the Node.js default bundle
const gisAgent = new https.Agent({ rejectUnauthorized: false });

function fetchGis(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: gisAgent }, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('GIS request timed out'));
    });
    req.on('error', reject);
  });
}

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

interface CadastralFeature {
  attributes: CadastralAttributes;
  geometry?: { rings: number[][][] };
}

function calculateCentroid(rings: number[][][]): { lat: number; lng: number } | null {
  if (!rings || !rings[0] || rings[0].length === 0) return null;
  const ring = rings[0];
  let sumLng = 0;
  let sumLat = 0;
  for (const point of ring) {
    sumLng += point[0] ?? 0;
    sumLat += point[1] ?? 0;
  }
  return { lng: sumLng / ring.length, lat: sumLat / ring.length };
}

function extractStreetAddress(q: string): string {
  const parts = q.split(',');
  return (parts[0] ?? q).trim();
}

function sanitizeLike(s: string): string {
  return s.replace(/'/g, "''").replace(/[;\\]/g, '').trim();
}

// USPS-style abbreviations that show up in listing addresses (both street-type
// suffixes like Rd/Ln and name words like Mdws/Crk). Listing sites and the state
// MSDI data disagree on which form they store — the cadastral abbreviates suffixes
// ("PRONGHORN LN") while a listing may spell them out, and vice versa for name
// words. So we search every form rather than betting on one.
const FULL_TO_ABBREV: Record<string, string> = {
  road: 'rd', street: 'st', avenue: 'ave', lane: 'ln', drive: 'dr',
  boulevard: 'blvd', court: 'ct', place: 'pl', highway: 'hwy', circle: 'cir',
  terrace: 'ter', parkway: 'pkwy', trail: 'trl', crossing: 'xing', junction: 'jct',
  meadows: 'mdws', creek: 'crk', view: 'vw', springs: 'spgs', spring: 'spg',
  heights: 'hts', valley: 'vly', ranch: 'rnch', village: 'vlg', lake: 'lk',
  lakes: 'lks', point: 'pt', ridge: 'rdg', summit: 'smt', station: 'sta',
  landing: 'lndg', estates: 'est', canyon: 'cyn', cove: 'cv', fork: 'frk',
  forks: 'frks', glen: 'gln', hill: 'hl', hills: 'hls', hollow: 'holw',
  knoll: 'knl', knolls: 'knls', mount: 'mt', mountain: 'mtn', plains: 'plns',
  river: 'riv', shores: 'shrs', vista: 'vis',
};
const ABBREV_TO_FULL: Record<string, string> = Object.fromEntries(
  Object.entries(FULL_TO_ABBREV).map(([full, abbr]) => [abbr, full])
);

// Replace whole alphabetic words per the map, leaving ordinals like "1st" intact
// (the \b guards prevent matching the "st" inside "1st").
function replaceWords(s: string, map: Record<string, string>): string {
  return s.replace(/\b[A-Za-z]+\b/g, (w) => map[w.toLowerCase()] ?? w);
}

// Original plus its fully-expanded and fully-abbreviated forms (deduped).
function addressVariants(s: string): string[] {
  const variants = [s, replaceWords(s, ABBREV_TO_FULL), replaceWords(s, FULL_TO_ABBREV)]
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(variants)];
}

// OR together a "<field> LIKE '%variant%'" clause for each abbreviation variant.
function likeAnyVariant(field: string, value: string): string {
  return addressVariants(value)
    .map((v) => `UPPER(${field}) LIKE UPPER('%${sanitizeLike(v)}%')`)
    .join(' OR ');
}

interface WrqsFeature {
  attributes: Record<string, unknown>;
}

interface WrqsResponse {
  features?: WrqsFeature[];
  error?: { message: string };
}

async function queryWrqsGeocodes(parcelIdCode: string): Promise<WrqsFeature[]> {
  const safe = parcelIdCode.replace(/'/g, "''");
  const params = new URLSearchParams({
    where: `GEOCD = '${safe}'`,
    outFields: WRQS_GEOCODE_FIELDS,
    resultRecordCount: '100',
    f: 'json',
  });

  const data = await fetchGis(`${DNRC_WRQS_GEOCODE_URL}?${params}`) as WrqsResponse;
  if (data.error) {
    logger.warn('WRQS geocode query error', { message: data.error.message });
    return [];
  }
  return data.features ?? [];
}

async function queryWrqsPlaceOfUse(
  rings: number[][][] | null,
  lat: number | null,
  lng: number | null,
): Promise<WrqsFeature[]> {
  let geometryParam: string;
  let geometryType: string;

  if (rings) {
    geometryParam = JSON.stringify({ rings });
    geometryType = 'esriGeometryPolygon';
  } else if (lat != null && lng != null) {
    geometryParam = JSON.stringify({ x: lng, y: lat });
    geometryType = 'esriGeometryPoint';
  } else {
    return [];
  }

  const params = new URLSearchParams({
    geometry: geometryParam,
    geometryType,
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    where: '1=1',
    outFields: WRQS_POU_FIELDS,
    resultRecordCount: '100',
    f: 'json',
  });

  // For point-only parcels use a small radius so we don't grab neighbors
  if (geometryType === 'esriGeometryPoint') {
    params.set('distance', '0.1');
    params.set('units', 'esriSRUnit_StatuteMile');
  }

  const data = await fetchGis(`${DNRC_WRQS_POU_URL}?${params}`) as WrqsResponse;
  if (data.error) {
    logger.warn('WRQS place-of-use query error', { message: data.error.message });
    return [];
  }
  return data.features ?? [];
}

function parseStatus(raw: unknown): 'active' | 'inactive' | 'pending' | 'unknown' {
  const s = ((raw as string) ?? '').toUpperCase();
  if (s.includes('ACTIVE') && !s.includes('IN')) return 'active';
  if (s.includes('INACTIVE') || s.includes('TERMINATED') || s.includes('ABANDONED') || s.includes('REVOKED')) return 'inactive';
  if (s.includes('PENDING') || s.includes('APPLICATION')) return 'pending';
  return 'unknown';
}

function parsePriorityDate(epochMs: unknown, fallback: unknown): string | null {
  if (typeof epochMs === 'number') return new Date(epochMs).toISOString().split('T')[0] ?? null;
  if (typeof fallback === 'string' && fallback) {
    const d = new Date(fallback);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0] ?? null;
  }
  return null;
}

function parseWaterType(sourceTypes: unknown): 'surface' | 'groundwater' | 'mixed' {
  const s = ((sourceTypes as string) ?? '').toUpperCase();
  if (s.includes('SURFACE') && s.includes('GROUND')) return 'mixed';
  if (s.includes('GROUND')) return 'groundwater';
  return 'surface';
}

interface MergedRight {
  wrNumber: string;
  waterSource: string | null;
  waterType: 'surface' | 'groundwater' | 'mixed';
  flowRateGpm: number | null;
  volume: number | null;
  priorityDate: string | null;
  status: 'active' | 'inactive' | 'pending' | 'unknown';
  rawData: Record<string, unknown>;
}

function fromGeocodeFeature(attr: Record<string, unknown>): MergedRight {
  return {
    wrNumber: attr.WR_NUMBER as string,
    waterSource: (attr.SOURCE_NAMES as string | null) ?? null,
    waterType: parseWaterType(attr.SOURCE_TYPES),
    flowRateGpm: (attr.MAX_FLOW_GPM as number | null) ?? null,
    volume: (attr.MAX_VOL as number | null) ?? null,
    priorityDate: parsePriorityDate(attr.ENF_PRTY_DT_DATE, null),
    status: parseStatus(attr.WR_STATUS),
    rawData: {
      source: 'dnrc_geocode',
      fetchedAt: new Date().toISOString(),
      geocd: attr.GEOCD ?? null,
    },
  };
}

function fromPouFeature(attr: Record<string, unknown>): MergedRight {
  return {
    wrNumber: attr.WR_NUMBER as string,
    waterSource: null, // source name lives on Point of Diversion layer, not POU
    waterType: 'surface', // default; geocode layer will override if present in both
    flowRateGpm: (attr.MAX_FLOW_GPM as number | null) ?? null,
    volume: (attr.MAX_VOL as number | null) ?? null,
    priorityDate: parsePriorityDate(attr.ENF_PRTY_DT_DATE, attr.ENF_PRTY_DT_CHAR),
    status: parseStatus(attr.WR_STATUS),
    rawData: {
      source: 'dnrc_place_of_use',
      fetchedAt: new Date().toISOString(),
      owners: attr.OWNERS ?? null,
      purpose: attr.PURPOSE ?? null,
      abstractUrl: attr.URL_ABSTRACT ?? null,
      geocodes: attr.GEOCODES ?? null,
    },
  };
}

function mergeRights(
  geocodeFeatures: WrqsFeature[],
  pouFeatures: WrqsFeature[],
): MergedRight[] {
  const byWrNumber = new Map<string, MergedRight>();

  for (const { attributes: attr } of geocodeFeatures) {
    const wrNumber = attr.WR_NUMBER as string;
    if (!wrNumber) continue;
    byWrNumber.set(wrNumber, fromGeocodeFeature(attr));
  }

  for (const { attributes: attr } of pouFeatures) {
    const wrNumber = attr.WR_NUMBER as string;
    if (!wrNumber) continue;

    const existing = byWrNumber.get(wrNumber);
    if (existing) {
      // Found in both — keep geocode fields (have source name/type) but add POU metadata
      existing.rawData = {
        ...existing.rawData,
        source: 'dnrc_both',
        owners: attr.OWNERS ?? null,
        purpose: attr.PURPOSE ?? null,
        abstractUrl: attr.URL_ABSTRACT ?? null,
        geocodes: attr.GEOCODES ?? null,
      };
    } else {
      byWrNumber.set(wrNumber, fromPouFeature(attr));
    }
  }

  return Array.from(byWrNumber.values());
}

async function seedWaterRights(
  parcelId: string,
  parcelIdCode: string,
  rings: number[][][] | null,
  lat: number | null,
  lng: number | null,
): Promise<void> {
  const [geocodeFeatures, pouFeatures] = await Promise.all([
    queryWrqsGeocodes(parcelIdCode),
    queryWrqsPlaceOfUse(rings, lat, lng),
  ]);

  logger.info('WRQS results', {
    parcelId,
    geocodeCount: geocodeFeatures.length,
    pouCount: pouFeatures.length,
  });

  const merged = mergeRights(geocodeFeatures, pouFeatures);

  if (merged.length === 0) return;

  await execute(
    `INSERT INTO water_rights
       (parcel_id, water_right_number, water_source, water_type, flow_rate, volume, priority_date, status, raw_data)
     SELECT
       $1::uuid,
       unnest($2::text[]),
       unnest($3::text[]),
       unnest($4::text[]),
       unnest($5::numeric[]),
       unnest($6::numeric[]),
       unnest($7::date[]),
       unnest($8::text[]),
       unnest($9::jsonb[])
     ON CONFLICT (parcel_id, water_right_number) DO UPDATE SET
       water_source  = COALESCE(EXCLUDED.water_source, water_rights.water_source),
       flow_rate     = COALESCE(EXCLUDED.flow_rate, water_rights.flow_rate),
       volume        = COALESCE(EXCLUDED.volume, water_rights.volume),
       priority_date = COALESCE(EXCLUDED.priority_date, water_rights.priority_date),
       status        = EXCLUDED.status,
       raw_data      = water_rights.raw_data || EXCLUDED.raw_data`,
    [
      parcelId,
      merged.map((r) => r.wrNumber),
      merged.map((r) => r.waterSource),
      merged.map((r) => r.waterType),
      merged.map((r) => r.flowRateGpm),
      merged.map((r) => r.volume),
      merged.map((r) => r.priorityDate),
      merged.map((r) => r.status),
      merged.map((r) => JSON.stringify(r.rawData)),
    ]
  );
}

interface CensusGeocodeResponse {
  result?: {
    addressMatches?: Array<{
      coordinates?: { x: number; y: number };
    }>;
  };
}

async function geocodeAddress(q: string): Promise<{ lat: number; lng: number } | null> {
  const params = new URLSearchParams({
    address: q,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });

  try {
    const data = await fetchGis(`${CENSUS_GEOCODER_URL}?${params}`) as CensusGeocodeResponse;
    const coords = data.result?.addressMatches?.[0]?.coordinates;
    if (!coords) return null;
    return { lat: coords.y, lng: coords.x };
  } catch (err) {
    logger.warn('Census geocoder failed', { error: String(err) });
    return null;
  }
}

function parseAddressParts(q: string): { street: string; city: string; state: string; zip?: string } | null {
  // Expect "123 Main St, City, ST 12345" or "123 Main St, City, ST"
  const parts = q.split(',').map((s) => s.trim());
  if (parts.length < 3) return null;
  const street = parts[0];
  const city = parts[1];
  const stateZip = parts[2] ?? '';
  const m = stateZip.match(/^([A-Za-z]{2})\s*(\d{5})?/);
  if (!m || !street || !city) return null;
  return { street, city, state: m[1]!, zip: m[2] };
}

async function geocodeAddressStructured(q: string): Promise<{ lat: number; lng: number } | null> {
  const parts = parseAddressParts(q);
  if (!parts) return null;

  const params = new URLSearchParams({
    street: parts.street,
    city: parts.city,
    state: parts.state,
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
  if (parts.zip) params.set('zip', parts.zip);

  try {
    const data = await fetchGis(`${CENSUS_GEOCODER_STRUCTURED_URL}?${params}`) as CensusGeocodeResponse;
    const coords = data.result?.addressMatches?.[0]?.coordinates;
    if (!coords) return null;
    return { lat: coords.y, lng: coords.x };
  } catch (err) {
    logger.warn('Census structured geocoder failed', { error: String(err) });
    return null;
  }
}

async function geocodeWithNominatim(q: string): Promise<{ lat: number; lng: number } | null> {
  const params = new URLSearchParams({ q, format: 'json', limit: '1', countrycodes: 'us' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'landfinder/1.0 (hcsneden@gmail.com)' },
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const data = await res.json() as Array<{ lat: string; lon: string }>;
    const first = data[0];
    if (!first) return null;
    return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
  } catch (err) {
    logger.warn('Nominatim geocoder failed', { error: String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseStreetNumber(street: string): { num: number | null; name: string } {
  const m = street.match(/^(\d+)\s+(.+)/);
  if (!m) return { num: null, name: street };
  // Strip trailing street type so it matches MontanaStructuresAddresses St_Name (no suffix stored)
  const name = (m[2] ?? '').replace(/\s+(rd|road|st|street|ave|avenue|ln|lane|dr|drive|way|blvd|ct|court|pl|place|hwy|highway|loop|trl|trail|run|cir|circle|pike|row)\.?$/i, '').trim();
  return { num: parseInt(m[1]!), name };
}

async function lookupCadastralById(parcelId: string): Promise<CadastralFeature | null> {
  const safe = parcelId.replace(/'/g, "''").replace(/[;\\]/g, '');
  const params = new URLSearchParams({
    where: `PARCELID = '${safe}'`,
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType,Subdivision,TotalValue',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'json',
  });
  const data = await fetchGis(`${CADASTRAL_URL}?${params}`) as { features?: CadastralFeature[]; error?: { message: string } };
  if (data.error) {
    logger.warn('Cadastral ID lookup error', { message: data.error.message });
    return null;
  }
  return data.features?.[0] ?? null;
}

async function lookupByAddressPoint(q: string): Promise<CadastralFeature | null> {
  const streetPart = extractStreetAddress(q);
  const cityPart = q.split(',')[1]?.trim() ?? '';
  const { num, name } = parseStreetNumber(streetPart);
  if (num === null || num === 0 || !name) return null;

  const safeCity = sanitizeLike(cityPart);

  const cityClause = safeCity ? ` AND UPPER(Post_Comm) LIKE UPPER('%${safeCity}%')` : '';
  const where = `Add_Number = ${num} AND (${likeAnyVariant('St_Name', name)})${cityClause}`;

  const params = new URLSearchParams({
    where,
    outFields: 'ParcelID,Add_Number,St_Name,Post_Comm',
    resultRecordCount: '1',
    f: 'json',
  });

  interface AddressPointResponse {
    features?: Array<{ attributes: { ParcelID?: string | null } }>;
    error?: { message: string };
  }

  const data = await fetchGis(`${MSDI_ADDRESS_URL}?${params}`) as AddressPointResponse;
  if (data.error) {
    logger.warn('Montana address point lookup error', { message: data.error.message });
    return null;
  }

  const parcelId = data.features?.[0]?.attributes?.ParcelID;
  if (!parcelId) return null;

  logger.info('Montana address point matched', { q, parcelId });
  return lookupCadastralById(parcelId);
}

async function lookupCadastralByPoint(lat: number, lng: number): Promise<CadastralFeature | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lng, y: lat }),
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType,Subdivision,TotalValue',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'json',
  });

  const data = await fetchGis(`${CADASTRAL_URL}?${params}`) as { features?: CadastralFeature[]; error?: { message: string } };

  if (data.error) {
    logger.error('Cadastral spatial query error', { message: data.error.message });
    return null;
  }

  return data.features?.[0] ?? null;
}

function isTbdAddress(q: string): boolean {
  // "TBD Foo Rd" or "0 Foo Rd" — both mean no specific house number
  return /^\s*(tbd|0)\s+/i.test(q);
}

// Rural subdivision listings are often phrased "Nhn Foo Rd Lot 69" (no house number,
// lot 69), but county E911/cadastral records assign that lot number as the actual
// situs address ("69 Foo Rd"). Rewriting to that form lets the normal house-number
// lookup paths match directly instead of falling back to fuzzy/geocoded search.
function rewriteLotNumberAsHouseNumber(q: string): string | null {
  const street = extractStreetAddress(q);
  if (/^\s*\d+\s+/.test(street)) return null; // already has a leading house number

  const m = street.match(/^(.*?)\s+lot\s*#?\s*(\d+)\s*$/i);
  if (!m) return null;

  const roadPart = (m[1] ?? '').replace(/^\s*(nhn|tbd|0)\s+/i, '').trim();
  const lotNum = m[2];
  if (!roadPart || !lotNum) return null;

  const rest = q.slice(street.length);
  return `${lotNum} ${roadPart}${rest}`;
}

function extractRoadName(q: string): string | null {
  // "Tbd Arcturus Dr, Emigrant, MT 59027" or "0 Arcturus Dr, ..." → "Arcturus Dr"
  const withoutPrefix = q.replace(/^\s*(tbd|0)\s+/i, '').trim();
  const road = withoutPrefix.split(',')[0]?.trim() ?? '';
  return road.length >= 3 ? road : null;
}

// Last-resort fallback once every exact-match strategy has missed: strip whatever
// house number/lot/prefix is present and search by road name alone, so we can offer
// the user a pick-list instead of a flat "not found".
function extractGenericRoadName(q: string): string | null {
  let road = extractStreetAddress(q);
  road = road.replace(/^\s*\d+\s+/, '');
  road = road.replace(/^\s*(nhn|tbd)\s+/i, '');
  road = road.replace(/\s+lot\s*#?\s*\d+\s*$/i, '');
  road = road.trim();
  return road.length >= 3 ? road : null;
}

function toParcelCandidates(features: CadastralFeature[]): ParcelCandidate[] {
  return features.map((f) => ({
    parcelId: f.attributes.PARCELID,
    address: f.attributes.AddressLine1
      ? `${f.attributes.AddressLine1.trim()}${f.attributes.CityStateZip ? ', ' + f.attributes.CityStateZip.trim() : ''}`
      : null,
    acreage: f.attributes.TotalAcres ?? f.attributes.GISAcres ?? null,
    county: f.attributes.CountyName ?? null,
    subdivision: f.attributes.Subdivision ?? null,
    totalValue: f.attributes.TotalValue ?? null,
    forSale: null,
    listingSummary: null,
  }));
}

// Listing status is only worth checking for a bounded number of candidates — each
// check is a Claude + web-search call, so capping keeps latency/cost predictable.
const LISTING_CHECK_CANDIDATE_CAP = 10;

async function enrichCandidatesWithListingStatus(
  features: CadastralFeature[]
): Promise<ParcelCandidate[]> {
  const base = toParcelCandidates(features);
  const toCheck = base.slice(0, LISTING_CHECK_CANDIDATE_CAP);

  const results = await Promise.allSettled(
    toCheck.map((c) =>
      c.address ? getOrCheckListingStatus(c.parcelId, c.address) : Promise.resolve(null)
    )
  );

  const enriched = base.map((c, i) => {
    if (i >= toCheck.length) return c;
    const r = results[i];
    if (r && r.status === 'fulfilled' && r.value) {
      return { ...c, forSale: r.value.forSale, listingSummary: r.value.summary };
    }
    return c;
  });

  // Surface the one actually for sale, without hiding how many parcels matched.
  return [...enriched.filter((c) => c.forSale), ...enriched.filter((c) => !c.forSale)];
}

async function lookupCadastralCandidates(road: string): Promise<CadastralFeature[]> {
  const params = new URLSearchParams({
    where: likeAnyVariant('AddressLine1', road),
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType,Subdivision,TotalValue',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '50',
    orderByFields: 'TotalAcres DESC',
    f: 'json',
  });

  const data = await fetchGis(`${CADASTRAL_URL}?${params}`) as { features?: CadastralFeature[]; error?: { message: string } };
  if (data.error) {
    logger.error('Cadastral candidate query error', { message: data.error.message });
    return [];
  }
  return data.features ?? [];
}

async function lookupCadastral(q: string): Promise<CadastralFeature | null> {
  const street = extractStreetAddress(q);
  const safeId = sanitizeLike(q);

  const where =
    `(${likeAnyVariant('AddressLine1', street)})` +
    ` OR UPPER(PARCELID) LIKE UPPER('%${safeId}%')`;

  const params = new URLSearchParams({
    where,
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType,Subdivision,TotalValue',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '1',
    f: 'json',
  });

  const data = await fetchGis(`${CADASTRAL_URL}?${params}`) as { features?: CadastralFeature[]; error?: { message: string } };

  if (data.error) {
    logger.error('Cadastral API error', { message: data.error.message });
    return null;
  }

  return data.features?.[0] ?? null;
}

interface UpsertedParcel {
  id: string;
  state: string;
  county: string | null;
  parcel_number: string | null;
  geo_id: string | null;
  address: string | null;
  acreage: number | null;
  building_value: number | null;
  prop_type: string | null;
  longitude: number | null;
  latitude: number | null;
  boundary: string | null;
  created_at: string;
  updated_at: string;
}

async function upsertParcelRecord(feature: CadastralFeature): Promise<UpsertedParcel> {
  const { attributes: attr, geometry } = feature;

  let latitude: number | null = null;
  let longitude: number | null = null;
  let boundaryGeoJson: string | null = null;

  if (geometry?.rings) {
    boundaryGeoJson = JSON.stringify({ type: 'Polygon', coordinates: geometry.rings });
    const centroid = calculateCentroid(geometry.rings);
    if (centroid) {
      latitude = centroid.lat;
      longitude = centroid.lng;
    }
  }

  const acreage = attr.TotalAcres ?? attr.GISAcres ?? null;

  const address = attr.AddressLine1
    ? `${attr.AddressLine1.trim()}${attr.CityStateZip ? ', ' + attr.CityStateZip.trim() : ''}`
    : null;

  const sqlParams: unknown[] = [
    'MT',
    attr.CountyName || null,
    attr.PARCELID,
    attr.PARCELID,
    address,
    acreage,
    attr.TotalBuildingValue ?? null,
    attr.PropType ?? null,
  ];

  let coordsSql = 'NULL';
  if (latitude != null && longitude != null) {
    sqlParams.push(longitude, latitude);
    coordsSql = `ST_SetSRID(ST_MakePoint($${sqlParams.length - 1}, $${sqlParams.length}), 4326)`;
  }

  let boundarySql = 'NULL';
  if (boundaryGeoJson != null) {
    sqlParams.push(boundaryGeoJson);
    boundarySql = `ST_GeomFromGeoJSON($${sqlParams.length})`;
  }

  const sql = `
    INSERT INTO parcels (state, county, parcel_number, geo_id, address, acreage, building_value, prop_type, coordinates, boundary, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${coordsSql}, ${boundarySql}, NOW(), NOW())
    ON CONFLICT (state, parcel_number) DO UPDATE SET
      county         = EXCLUDED.county,
      geo_id         = EXCLUDED.geo_id,
      address        = EXCLUDED.address,
      acreage        = EXCLUDED.acreage,
      building_value = EXCLUDED.building_value,
      prop_type      = EXCLUDED.prop_type,
      coordinates    = COALESCE(EXCLUDED.coordinates, parcels.coordinates),
      boundary       = COALESCE(EXCLUDED.boundary, parcels.boundary),
      updated_at     = NOW()
    RETURNING
      id, state, county, parcel_number, geo_id, address, acreage, building_value, prop_type,
      ST_X(coordinates::geometry) as longitude,
      ST_Y(coordinates::geometry) as latitude,
      ST_AsGeoJSON(boundary)::text as boundary,
      created_at, updated_at
  `;

  const rows = await query<UpsertedParcel>(sql, sqlParams);
  const firstRow = rows[0];
  if (!firstRow) throw new Error('No row returned from parcel upsert');
  return firstRow;
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    const rawQ = event.queryStringParameters?.q?.trim();
    if (!rawQ || rawQ.length < 3) {
      return badRequest('Query parameter "q" is required (minimum 3 characters)');
    }

    // Start a paused Aurora resuming now, in parallel with the Cadastral calls below,
    // instead of paying the full resume when the first upsert runs. Fire and forget:
    // the upsert has its own resume retries if this has not finished by then.
    void query('SELECT 1').catch(() => undefined);

    const lotRewrite = rewriteLotNumberAsHouseNumber(rawQ);
    const q = lotRewrite ?? rawQ;
    if (lotRewrite) {
      logger.info('Rewrote lot-number address to house-number form', { original: rawQ, rewritten: lotRewrite });
    }

    // TBD addresses have no street number — try road-name candidate search first
    if (isTbdAddress(q)) {
      const road = extractRoadName(q);
      if (road) {
        const candidates = await lookupCadastralCandidates(road);
        if (candidates.length > 1) {
          logger.info('TBD address returned candidates', { q, road, count: candidates.length });
          return success({ candidates: await enrichCandidatesWithListingStatus(candidates), roadName: road });
        }
        if (candidates.length === 1) {
          // Exactly one parcel on this road — use it directly. Falling through to
          // lookupCadastral would re-query with the "0 " prefix in the LIKE clause,
          // which misses parcels stored without a house number in the cadastral data.
          const feature = candidates[0]!;
          const row = await upsertParcelRecord(feature);
          if (feature.attributes.PARCELID) {
            const rings = feature.geometry?.rings ?? null;
            const centroid = rings ? calculateCentroid(rings) : null;
            try {
              await seedWaterRights(row.id, feature.attributes.PARCELID, rings, centroid?.lat ?? null, centroid?.lng ?? null);
            } catch (err) {
              logger.warn('Water rights fetch failed during TBD lookup', { parcelId: row.id, error: String(err) });
            }
          }
          const parcel: Parcel = {
            id: row.id, state: row.state, county: row.county,
            parcelNumber: row.parcel_number, geoId: row.geo_id, address: row.address,
            acreage: row.acreage, buildingValue: row.building_value, propType: row.prop_type,
            coordinates: row.latitude != null && row.longitude != null
              ? { latitude: row.latitude, longitude: row.longitude } : null,
            boundary: row.boundary ? JSON.parse(row.boundary) as Parcel['boundary'] : null,
            createdAt: row.created_at, updatedAt: row.updated_at,
          };
          logger.info('TBD address resolved to single candidate', { q, road, parcelId: parcel.id });
          return success(parcel);
        }
        // 0 results: fall through to other lookup strategies
      }
    }

    let feature = await lookupCadastral(q);

    if (!feature) {
      feature = await lookupByAddressPoint(q);
    }

    if (!feature) {
      let coords = await geocodeAddress(q);
      if (!coords) {
        coords = await geocodeAddressStructured(q);
      }
      if (!coords) {
        logger.info('Census geocoders missed, trying Nominatim fallback', { q });
        coords = await geocodeWithNominatim(q);
      }
      if (coords) {
        logger.info('Geocode succeeded, trying spatial fallback', { q, coords });
        feature = await lookupCadastralByPoint(coords.lat, coords.lng);
      }
    }

    if (!feature) {
      // Every exact-match strategy missed — try the road name alone so we can offer
      // a pick-list instead of a flat "not found" when several parcels share it.
      const road = extractGenericRoadName(q);
      if (road) {
        const candidates = await lookupCadastralCandidates(road);
        if (candidates.length > 1) {
          logger.info('Fallback road search returned candidates', { q, road, count: candidates.length });
          return success({ candidates: await enrichCandidatesWithListingStatus(candidates), roadName: road });
        }
        if (candidates.length === 1) {
          feature = candidates[0]!;
          logger.info('Fallback road search resolved to single candidate', { q, road });
        }
      }
    }

    if (!feature) {
      return success(null);
    }

    const row = await upsertParcelRecord(feature);

    if (feature.attributes.PARCELID) {
      const rings = feature.geometry?.rings ?? null;
      const centroid = rings ? calculateCentroid(rings) : null;
      try {
        await seedWaterRights(
          row.id,
          feature.attributes.PARCELID,
          rings,
          centroid?.lat ?? null,
          centroid?.lng ?? null,
        );
      } catch (err) {
        logger.warn('Water rights fetch failed during lookup', { parcelId: row.id, error: String(err) });
      }
    }

    const parcel: Parcel = {
      id: row.id,
      state: row.state,
      county: row.county,
      parcelNumber: row.parcel_number,
      geoId: row.geo_id,
      address: row.address,
      acreage: row.acreage,
      buildingValue: row.building_value,
      propType: row.prop_type,
      coordinates:
        row.latitude != null && row.longitude != null
          ? { latitude: row.latitude, longitude: row.longitude }
          : null,
      boundary: row.boundary ? JSON.parse(row.boundary) as Parcel['boundary'] : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    return success(parcel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Parcel lookup error', { error: msg });
    if (msg.includes('timed out')) {
      return errorResponse(503, 'SERVICE_UNAVAILABLE', 'The parcel lookup service is temporarily slow. Please try again.');
    }
    return serverError('An error occurred during parcel lookup');
  }
}
