import type { ListingStatus, ListingStatusConfidence } from '@lastbestland/shared';
import { query, queryOne, execute } from './db';
import { searchWeb } from './webSearch';
import { checkListingStatusFromSearchResults } from './bedrock';
import { logger } from './logger';
import { days } from './parcelCache';

const LISTING_STATUS_TTL_MS = days(7);

// Each live check is a web search plus a model call, so a result set is served
// from cache first and only this many misses are checked, a few at a time.
const BATCH_LIVE_CHECK_CAP = 15;
const BATCH_CONCURRENCY = 5;

export type ListingStatusResult = Omit<ListingStatus, 'parcelId'>;

interface CacheRow {
  parcel_number: string;
  for_sale: boolean;
  confidence: ListingStatusConfidence;
  price: number | null;
  listing_url: string | null;
  source: string | null;
  summary: string;
  fetched_at: string;
}

const CACHE_COLUMNS = 'parcel_number, for_sale, confidence, price, listing_url, source, summary, fetched_at::text';

function toResult(row: CacheRow): ListingStatusResult {
  return {
    forSale: row.for_sale,
    confidence: row.confidence,
    price: row.price,
    listingUrl: row.listing_url,
    source: row.source,
    summary: row.summary,
    fetchedAt: row.fetched_at,
  };
}

/**
 * Returns the for-sale status for a parcel, checking the web when the cached
 * status is older than the TTL. Keyed by the cadastral parcel number rather
 * than the internal parcel ID so candidates from an ambiguous lookup can be
 * checked before they are stored.
 */
export async function getOrCheckListingStatus(
  parcelNumber: string,
  address: string,
  forceRefresh = false
): Promise<ListingStatusResult | null> {
  const cached = await queryOne<CacheRow>(
    `SELECT ${CACHE_COLUMNS} FROM listing_status_cache WHERE parcel_number = $1`,
    [parcelNumber]
  );
  const cacheAgeMs = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
  if (cached && !forceRefresh && cacheAgeMs <= LISTING_STATUS_TTL_MS) return toResult(cached);

  try {
    const results = await searchWeb(`"${address}" for sale`);
    const check = await checkListingStatusFromSearchResults(address, results);
    const fetchedAt = new Date().toISOString();
    await execute(
      `INSERT INTO listing_status_cache (parcel_number, for_sale, confidence, price, listing_url, source, summary, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (parcel_number) DO UPDATE SET
         for_sale = EXCLUDED.for_sale,
         confidence = EXCLUDED.confidence,
         price = EXCLUDED.price,
         listing_url = EXCLUDED.listing_url,
         source = EXCLUDED.source,
         summary = EXCLUDED.summary,
         fetched_at = EXCLUDED.fetched_at`,
      [parcelNumber, check.forSale, check.confidence, check.price, check.listingUrl, check.source, check.summary, fetchedAt]
    );
    return { ...check, fetchedAt };
  } catch (err) {
    logger.warn('Listing status check failed', { parcelNumber, error: String(err) });
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AddressedParcel {
  parcelNumber: string | null;
  address: string | null;
}

/**
 * Returns for-sale status for a set of parcels, keyed by cadastral parcel
 * number. Cache hits are free. Misses are checked live in the order given, up
 * to a cap, so pass the parcels a user is most likely to look at first.
 * Parcels without an address cannot be checked and are omitted.
 */
export async function getListingStatusesForParcels(
  parcels: AddressedParcel[]
): Promise<Map<string, ListingStatusResult>> {
  const addressable = parcels.filter(
    (p): p is { parcelNumber: string; address: string } => Boolean(p.parcelNumber && p.address)
  );
  if (addressable.length === 0) return new Map();

  const rows = await query<CacheRow>(
    `SELECT ${CACHE_COLUMNS} FROM listing_status_cache
     WHERE parcel_number = ANY($1::text[]) AND fetched_at > $2::timestamptz`,
    [addressable.map((p) => p.parcelNumber), new Date(Date.now() - LISTING_STATUS_TTL_MS).toISOString()]
  );
  const statuses = new Map(rows.map((row) => [row.parcel_number, toResult(row)]));

  const misses = addressable.filter((p) => !statuses.has(p.parcelNumber)).slice(0, BATCH_LIVE_CHECK_CAP);
  const checked = await mapWithConcurrency(misses, BATCH_CONCURRENCY, (p) =>
    getOrCheckListingStatus(p.parcelNumber, p.address)
  );
  checked.forEach((result, i) => {
    if (result) statuses.set(misses[i]!.parcelNumber, result);
  });

  logger.info('Batch listing status resolved', {
    requested: addressable.length,
    resolved: statuses.size,
    liveChecks: misses.length,
  });
  return statuses;
}
