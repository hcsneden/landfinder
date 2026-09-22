import type { SearchCriteria } from '@lastbestland/shared';
import { parcelColumns } from '../shared/parcels';

const MAX_RESULTS = 100;

export interface SearchQuery {
  sql: string;
  params: unknown[];
}

/**
 * Builds the parcel search query. Price filters use the cached for-sale check,
 * which is the only price source the app has.
 */
export function buildSearchQuery(criteria: SearchCriteria): SearchQuery {
  const params: unknown[] = [];
  const conditions: string[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;

  conditions.push(`p.state = ${bind(criteria.state)}`);
  if (criteria.county) conditions.push(`p.county = ${bind(criteria.county)}`);
  if (criteria.minAcreage !== undefined) conditions.push(`p.acreage >= ${bind(criteria.minAcreage)}`);
  if (criteria.maxAcreage !== undefined) conditions.push(`p.acreage <= ${bind(criteria.maxAcreage)}`);
  if (criteria.minPrice !== undefined) conditions.push(`ls.price >= ${bind(criteria.minPrice)}`);
  if (criteria.maxPrice !== undefined) conditions.push(`ls.price <= ${bind(criteria.maxPrice)}`);
  if (criteria.waterRightsRequired) {
    conditions.push('EXISTS (SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id)');
  }
  if (criteria.bbox) {
    const { minLng, minLat, maxLng, maxLat } = criteria.bbox;
    conditions.push(
      `ST_Within(p.coordinates::geometry, ST_MakeEnvelope(${bind(minLng)}, ${bind(minLat)}, ${bind(maxLng)}, ${bind(maxLat)}, 4326))`
    );
  }

  const sql = `
    SELECT
      ${parcelColumns('p')},
      EXISTS (SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id) AS has_water_rights,
      (SELECT content FROM parcel_insights
        WHERE parcel_id = p.id AND insight_type = 'summary'
        ORDER BY created_at DESC LIMIT 1) AS preview_insight
    FROM parcels p
    LEFT JOIN listing_status_cache ls ON ls.parcel_number = p.parcel_number AND ls.for_sale
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.updated_at DESC
    LIMIT ${MAX_RESULTS}`;
  return { sql, params };
}
