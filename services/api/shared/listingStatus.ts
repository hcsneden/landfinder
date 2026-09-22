import { query, queryOne, execute } from './db';
import { searchWeb } from './webSearch';
import { checkListingStatusFromSearchResults } from './bedrock';
import { logger } from './logger';

const LISTING_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ListingStatusResult {
  forSale: boolean;
  confidence: 'high' | 'medium' | 'low';
  price: number | null;
  listingUrl: string | null;
  source: string | null;
  summary: string;
  fetchedAt: string;
}

// price is DECIMAL in Postgres, and the Data API decoder returns numeric as a
// string to avoid precision loss on big values. Typed as it actually arrives, then
// converted once in rowToResult, so a cache hit and a fresh check agree.
interface CacheRow {
  for_sale: boolean;
  confidence: string;
  price: string | null;
  listing_url: string | null;
  source: string | null;
  summary: string;
  fetched_at: string;
}

function rowToResult(row: CacheRow): ListingStatusResult {
  return {
    forSale: row.for_sale,
    confidence: row.confidence as ListingStatusResult['confidence'],
    price: row.price === null ? null : Number(row.price),
    listingUrl: row.listing_url,
    source: row.source,
    summary: row.summary,
    fetchedAt: row.fetched_at,
  };
}

const CACHE_COLUMNS =
  'for_sale, confidence, price, listing_url, source, summary, fetched_at::text';

/**
 * Run the check and store it. Assumes the caller has already decided the cache
 * cannot answer, so it does not read the cache first.
 */
async function checkAndStore(
  parcelNumber: string,
  address: string
): Promise<ListingStatusResult | null> {
  try {
    const searchResults = await searchWeb(`"${address}" for sale`);
    const result = await checkListingStatusFromSearchResults(address, searchResults);
    const fetchedAt = new Date().toISOString();

    await execute(
      `INSERT INTO listing_status_cache (parcel_number, for_sale, confidence, price, listing_url, source, summary, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (parcel_number) DO UPDATE SET
         for_sale = EXCLUDED.for_sale,
         confidence = EXCLUDED.confidence,
         price = EXCLUDED.price,
         listing_url = EXCLUDED.listing_url,
         source = EXCLUDED.source,
         summary = EXCLUDED.summary,
         fetched_at = NOW()`,
      [parcelNumber, result.forSale, result.confidence, result.price, result.listingUrl, result.source, result.summary]
    );

    return { ...result, fetchedAt };
  } catch (err) {
    logger.warn('Listing status check failed', {
      parcelNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Keyed by the cadastral PARCELID rather than the internal parcels.id UUID, since
// candidate parcels from an ambiguous search aren't upserted into `parcels` until
// the user picks one — this lets us cache/check them before that happens.
export async function getOrCheckListingStatus(
  parcelNumber: string,
  address: string | null,
  opts: { forceRefresh?: boolean } = {}
): Promise<ListingStatusResult | null> {
  if (!address) return null;

  const cached = await queryOne<CacheRow>(
    `SELECT ${CACHE_COLUMNS} FROM listing_status_cache WHERE parcel_number = $1`,
    [parcelNumber]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!opts.forceRefresh && cached && cacheAge <= LISTING_STATUS_TTL_MS) {
    return rowToResult(cached);
  }

  return checkAndStore(parcelNumber, address);
}

// Each fresh check is a web search plus a Bedrock call, so a result set is served
// from cache first and only a bounded number of misses are checked live. The rest
// come back null and get filled on a later search that hits the same parcels.
const BATCH_LIVE_CHECK_CAP = 15;
const BATCH_CONCURRENCY = 5;

// One query for the whole result set rather than a round trip per parcel. The
// freshness window is the same TTL the single-parcel path uses, passed as a
// parameter so the two cannot drift apart.
async function getCachedListingStatuses(
  parcelNumbers: string[]
): Promise<Map<string, ListingStatusResult>> {
  if (parcelNumbers.length === 0) return new Map();

  const rows = await query<CacheRow & { parcel_number: string }>(
    `SELECT parcel_number, ${CACHE_COLUMNS}
     FROM listing_status_cache
     WHERE parcel_number = ANY($1::text[])
       AND fetched_at > NOW() - ($2::text || ' milliseconds')::interval`,
    [parcelNumbers, String(LISTING_STATUS_TTL_MS)]
  );

  return new Map(rows.map((r) => [r.parcel_number, rowToResult(r)]));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * For-sale status for a set of parcels, keyed by cadastral parcel number.
 *
 * Cache hits are free. Misses are checked live up to BATCH_LIVE_CHECK_CAP, in the
 * order given, so callers should pass the parcels a user is most likely to look at
 * first. A parcel with no address cannot be checked and is omitted.
 */
export async function getListingStatusesForParcels(
  parcels: Array<{ parcelNumber: string | null; address: string | null }>
): Promise<Map<string, ListingStatusResult>> {
  // Deduped by parcel number: the same parcel appearing twice in a result set would
  // otherwise spend two live checks on one answer.
  const addressable = [
    ...new Map(
      parcels
        .filter(
          (p): p is { parcelNumber: string; address: string } => !!p.parcelNumber && !!p.address
        )
        .map((p) => [p.parcelNumber, p] as const)
    ).values(),
  ];
  if (addressable.length === 0) return new Map();

  const statuses = await getCachedListingStatuses(addressable.map((p) => p.parcelNumber));

  const misses = addressable
    .filter((p) => !statuses.has(p.parcelNumber))
    .slice(0, BATCH_LIVE_CHECK_CAP);

  if (misses.length > 0) {
    // checkAndStore rather than getOrCheckListingStatus: the query above already
    // established these are misses, so re-reading the cache per parcel would be
    // BATCH_LIVE_CHECK_CAP extra Data API round trips for a known answer.
    const checked = await mapWithConcurrency(misses, BATCH_CONCURRENCY, (p) =>
      checkAndStore(p.parcelNumber, p.address)
    );

    checked.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        statuses.set(misses[i]!.parcelNumber, r.value);
      }
    });
  }

  logger.info('Batch listing status resolved', {
    requested: addressable.length,
    resolved: statuses.size,
    liveChecks: misses.length,
  });

  return statuses;
}
