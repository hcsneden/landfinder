import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { Parcel } from '@lastbestland/shared';
import { queryOne } from './db';
import { env } from './env';
import { logger } from './logger';
import { metrics, MetricUnit } from './metrics';
import { tracer } from './tracer';
import { parcelColumns, toParcel, type ParcelRow } from './parcels';

/**
 * Enrichment and parcel records are cached in DynamoDB rather than Postgres so a
 * repeat view never wakes Aurora. Aurora pauses at 0 ACU after ten idle minutes
 * and takes about 20 seconds to resume, so any read that can be served from cache
 * must not touch it. Aurora is still the source of truth and still serves cache
 * misses, spatial search, and every write.
 */
const docClient = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})), {
  marshallOptions: { removeUndefinedValues: true },
});

export type EnrichmentSource =
  | 'road_access'
  | 'utilities'
  | 'environmental_risk'
  | 'conservation_easements'
  | 'soil'
  | 'groundwater';

/** Sort key for the base parcel record, which shares the table with enrichment. */
const PARCEL_RECORD = 'parcel';

export interface CachedPayload<T> {
  payload: T;
  fetchedAt: string;
}

interface CacheItem {
  parcelId: string;
  source: string;
  payload: unknown;
  fetchedAt: string;
  ttl: number;
}

export const days = (n: number) => n * 24 * 60 * 60 * 1000;

/** Cadastral data changes slowly, and an upsert invalidates this explicitly. */
const PARCEL_RECORD_TTL_MS = days(7);

/**
 * DynamoDB row expiry, deliberately far longer than the logical TTL.
 *
 * The logical TTL decides when to refetch. This decides when to forget. Keeping
 * rows well past their logical expiry preserves the stale-on-error fallback
 * below, which is the only thing standing between an upstream outage and a blank
 * section in the UI. DynamoDB TTL deletion is best effort and can lag by up to 48
 * hours, so nothing may rely on it for correctness.
 */
function expiryEpochSeconds(ttlMs: number): number {
  const retentionMs = Math.max(ttlMs * 4, days(90));
  return Math.floor((Date.now() + retentionMs) / 1000);
}

async function readCache(parcelId: string, source: string): Promise<CacheItem | null> {
  try {
    const result = await docClient.send(
      new GetCommand({ TableName: env.parcelCacheTable, Key: { parcelId, source } })
    );
    return (result.Item as CacheItem | undefined) ?? null;
  } catch (err) {
    // A cache read failure must not fail the request. Fall through to the source.
    logger.warn('Parcel cache read failed', { source, parcelId, error: String(err) });
    return null;
  }
}

async function writeCache(item: CacheItem): Promise<void> {
  try {
    await docClient.send(new PutCommand({ TableName: env.parcelCacheTable, Item: item }));
  } catch (err) {
    logger.warn('Parcel cache write failed', { source: item.source, parcelId: item.parcelId, error: String(err) });
  }
}

/**
 * Returns the cached payload for a parcel and source when it is younger than
 * `ttlMs`, otherwise calls `fetchFresh` and caches its result. When the fetch
 * fails and a stale entry exists, the stale entry is returned so a transient
 * upstream outage does not blank the UI.
 */
export async function withParcelCache<T>(
  source: EnrichmentSource,
  parcelId: string,
  ttlMs: number,
  forceRefresh: boolean,
  fetchFresh: () => Promise<T>
): Promise<CachedPayload<T> | null> {
  const cached = await readCache(parcelId, source);
  const cacheAgeMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

  if (cached && !forceRefresh && cacheAgeMs <= ttlMs) {
    metrics.addMetric('ParcelCacheHit', MetricUnit.Count, 1);
    return { payload: cached.payload as T, fetchedAt: cached.fetchedAt };
  }

  metrics.addMetric('ParcelCacheMiss', MetricUnit.Count, 1);

  try {
    const payload = await fetchFresh();
    const fetchedAt = new Date().toISOString();
    await writeCache({ parcelId, source, payload, fetchedAt, ttl: expiryEpochSeconds(ttlMs) });
    return { payload, fetchedAt };
  } catch (err) {
    logger.warn('Enrichment fetch failed', { source, parcelId, error: String(err) });
    if (!cached) return null;
    metrics.addMetric('ParcelCacheStaleServed', MetricUnit.Count, 1);
    return { payload: cached.payload as T, fetchedAt: cached.fetchedAt };
  }
}

/**
 * The parcel record itself, from cache when possible.
 *
 * This is the read that decides whether a parcel view wakes Aurora at all, since
 * every other section of the detail view is cached per source. Returns null when
 * the parcel does not exist.
 */
export async function getCachedParcel(parcelId: string, forceRefresh = false): Promise<Parcel | null> {
  const cached = await readCache(parcelId, PARCEL_RECORD);
  const cacheAgeMs = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;

  if (cached && !forceRefresh && cacheAgeMs <= PARCEL_RECORD_TTL_MS) {
    metrics.addMetric('ParcelRecordCacheHit', MetricUnit.Count, 1);
    return cached.payload as Parcel;
  }

  const row = await queryOne<ParcelRow>(
    `SELECT ${parcelColumns()} FROM parcels WHERE id = $1::uuid`,
    [parcelId]
  );
  // Only a miss on a parcel that exists is worth caching. A miss on a bad id
  // should not write a negative entry that later has to be invalidated.
  if (!row) return cached ? (cached.payload as Parcel) : null;

  const parcel = toParcel(row);
  metrics.addMetric('ParcelRecordCacheMiss', MetricUnit.Count, 1);
  await writeCache({
    parcelId,
    source: PARCEL_RECORD,
    payload: parcel,
    fetchedAt: new Date().toISOString(),
    ttl: expiryEpochSeconds(PARCEL_RECORD_TTL_MS),
  });
  return parcel;
}

/**
 * Drops the cached parcel record. Called after an upsert writes new cadastral
 * data, so the next read repopulates from Postgres rather than serving the
 * record the upsert just replaced.
 */
export async function invalidateCachedParcel(parcelId: string): Promise<void> {
  try {
    await docClient.send(
      new DeleteCommand({ TableName: env.parcelCacheTable, Key: { parcelId, source: PARCEL_RECORD } })
    );
  } catch (err) {
    logger.warn('Parcel cache invalidation failed', { parcelId, error: String(err) });
  }
}

export interface ParcelSearchArea {
  /** Buffered parcel boundary as ArcGIS rings in WGS84. */
  rings: number[][][];
  lat: number;
  lon: number;
}

interface SearchAreaRow {
  polygon: string | null;
  lat: number | null;
  lon: number | null;
}

/**
 * Returns the parcel boundary buffered by `boundaryBufferMeters`, or a circle of
 * `pointBufferMeters` around the parcel point when no boundary is stored.
 * Buffering on geography avoids picking a UTM zone.
 *
 * Not cached: this only runs on an enrichment cache miss, which is already going
 * to Postgres and to a slow upstream service.
 */
export async function parcelSearchArea(
  parcelId: string,
  boundaryBufferMeters: number,
  pointBufferMeters: number
): Promise<ParcelSearchArea | null> {
  const row = await queryOne<SearchAreaRow>(
    `SELECT
       ST_AsGeoJSON(ST_Buffer(
         COALESCE(boundary, coordinates),
         CASE WHEN boundary IS NULL THEN $3 ELSE $2 END
       )::geometry)::text AS polygon,
       ST_Y(coordinates::geometry) AS lat,
       ST_X(coordinates::geometry) AS lon
     FROM parcels WHERE id = $1::uuid`,
    [parcelId, boundaryBufferMeters, pointBufferMeters]
  );
  if (!row?.polygon || row.lat === null || row.lon === null) return null;
  const geojson = JSON.parse(row.polygon) as { coordinates: number[][][] };
  return { rings: geojson.coordinates, lat: row.lat, lon: row.lon };
}

export function parseRefreshFlag(queryStringParameters: Record<string, string | undefined> | null): boolean {
  return queryStringParameters?.refresh === 'true';
}
