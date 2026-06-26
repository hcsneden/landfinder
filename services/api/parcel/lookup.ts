import https from 'https';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { query, queryOne, execute } from '../shared/db';
import { success, badRequest, serverError, error as errorResponse } from '../shared/response';
import { logger } from '../shared/logger';
import type { Parcel } from '@landfinder/shared';

const CADASTRAL_URL =
  'https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0/query';
const DNRC_WRQS_URL =
  'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query';
const TIMEOUT_MS = 25_000;

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
  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lng: sumLng / ring.length, lat: sumLat / ring.length };
}

// Extract just the street address part so city/state/zip don't break the LIKE query
function extractStreetAddress(q: string): string {
  return q.includes(',') ? q.split(',')[0].trim() : q.trim();
}

async function lookupCadastral(q: string): Promise<CadastralFeature | null> {
  const street = extractStreetAddress(q);
  const safeStreet = street.replace(/'/g, "''").replace(/[;\\]/g, '').trim();
  const safeId = q.replace(/'/g, "''").replace(/[;\\]/g, '').trim();

  const where =
    `UPPER(AddressLine1) LIKE UPPER('%${safeStreet}%')` +
    ` OR UPPER(PARCELID) LIKE UPPER('%${safeId}%')`;

  const params = new URLSearchParams({
    where,
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres',
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

async function upsertParcelRecord(feature: CadastralFeature): Promise<string> {
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

  // Build a full address from MSDI components
  const address = attr.AddressLine1
    ? `${attr.AddressLine1.trim()}${attr.CityStateZip ? ', ' + attr.CityStateZip.trim() : ''}`
    : null;

  const sqlParams: unknown[] = [
    'MT',
    attr.CountyName || null,
    attr.PARCELID,
    attr.PARCELID, // use PARCELID as geo_id (it's the DOR geocode)
    address,
    acreage,
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
    INSERT INTO parcels (state, county, parcel_number, geo_id, address, acreage, coordinates, boundary, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, ${coordsSql}, ${boundarySql}, NOW(), NOW())
    ON CONFLICT (state, parcel_number) DO UPDATE SET
      county     = EXCLUDED.county,
      geo_id     = EXCLUDED.geo_id,
      address    = EXCLUDED.address,
      acreage    = EXCLUDED.acreage,
      coordinates = COALESCE(EXCLUDED.coordinates, parcels.coordinates),
      boundary   = COALESCE(EXCLUDED.boundary, parcels.boundary),
      updated_at = NOW()
    RETURNING id
  `;

  const rows = await query<{ id: string }>(sql, sqlParams);
  return rows[0].id;
}

async function seedWaterRights(parcelId: string, parcelIdCode: string): Promise<void> {
  const params = new URLSearchParams({
    where: `GEOCD = '${parcelIdCode.replace(/'/g, "''")}'`,
    outFields: 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_VOL',
    resultRecordCount: '100',
    f: 'json',
  });

  const data = await fetchGis(`${DNRC_WRQS_URL}?${params}`) as {
    features?: { attributes: Record<string, unknown> }[];
    error?: { message: string };
  };

  if (data.error || !data.features) return;

  for (const { attributes: attr } of data.features) {
    const wrNumber = attr.WR_NUMBER as string;
    if (!wrNumber) continue;

    const priorityDate =
      typeof attr.ENF_PRTY_DT_DATE === 'number'
        ? new Date(attr.ENF_PRTY_DT_DATE).toISOString().split('T')[0]
        : null;

    const s = ((attr.WR_STATUS as string) ?? '').toUpperCase();
    const status =
      s.includes('ACTIVE') && !s.includes('IN') ? 'active'
      : s.includes('INACTIVE') || s.includes('TERMINATED') || s.includes('ABANDONED') ? 'inactive'
      : s.includes('PENDING') ? 'pending'
      : 'active';

    const st = ((attr.SOURCE_TYPES as string) ?? '').toUpperCase();
    const waterType =
      st.includes('SURFACE') && st.includes('GROUND') ? 'mixed'
      : st.includes('GROUND') ? 'groundwater'
      : 'surface';

    await execute(
      `INSERT INTO water_rights
         (parcel_id, water_right_number, water_source, water_type, flow_rate, volume, priority_date, status, raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (parcel_id, water_right_number) DO NOTHING`,
      [
        parcelId, wrNumber, attr.SOURCE_NAMES ?? null, waterType,
        attr.MAX_FLOW_GPM ?? null, attr.MAX_VOL ?? null, priorityDate, status,
        JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'dnrc_lookup' }),
      ]
    );
  }
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    const q = event.queryStringParameters?.q?.trim();
    if (!q || q.length < 3) {
      return badRequest('Query parameter "q" is required (minimum 3 characters)');
    }

    const feature = await lookupCadastral(q);
    if (!feature) {
      // Return 200 with null data so the frontend can show "no results" rather than an error
      return success(null);
    }

    const parcelId = await upsertParcelRecord(feature);

    if (feature.attributes.PARCELID) {
      try {
        await seedWaterRights(parcelId, feature.attributes.PARCELID);
      } catch (err) {
        logger.warn('Water rights fetch failed during lookup', { parcelId, error: String(err) });
      }
    }

    const row = await queryOne<{
      id: string; state: string; county: string | null; parcel_number: string | null;
      geo_id: string | null; address: string | null; acreage: number | null;
      longitude: number | null; latitude: number | null; boundary: string | null;
      created_at: string; updated_at: string;
    }>(
      `SELECT id, state, county, parcel_number, geo_id, address, acreage,
              ST_X(coordinates::geometry) as longitude,
              ST_Y(coordinates::geometry) as latitude,
              ST_AsGeoJSON(boundary)::text as boundary,
              created_at, updated_at
       FROM parcels WHERE id = $1`,
      [parcelId]
    );

    if (!row) return serverError('Failed to retrieve parcel after upsert');

    const parcel: Parcel = {
      id: row.id,
      state: row.state,
      county: row.county,
      parcelNumber: row.parcel_number,
      geoId: row.geo_id,
      address: row.address,
      acreage: row.acreage,
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
