import { fetchJson } from './http';

export interface ArcGisFeature<A = Record<string, unknown>> {
  attributes: A;
  geometry?: { rings?: number[][][]; x?: number; y?: number };
}

interface ArcGisQueryResponse<A> {
  features?: ArcGisFeature<A>[];
  error?: { message: string };
}

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Runs an ArcGIS REST `query` request and returns its features.
 *
 * Parameters go in a POST form body rather than the URL. A buffered parcel
 * boundary can serialize to tens of kilobytes of geometry, which exceeds the
 * URL length some hosts accept.
 */
export async function queryArcGis<A = Record<string, unknown>>(
  url: string,
  params: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<ArcGisFeature<A>[]> {
  const body = new URLSearchParams({ f: 'json', ...params });
  const data = await fetchJson<ArcGisQueryResponse<A>>(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    timeoutMs
  );
  if (data.error) throw new Error(`ArcGIS error from ${new URL(url).host}: ${data.error.message}`);
  return data.features ?? [];
}

/** Escapes a value for use inside a single-quoted ArcGIS SQL literal. */
export function arcGisLiteral(value: string): string {
  return value.replace(/'/g, "''").replace(/[;\\]/g, '').trim();
}

export function polygonGeometryParams(rings: number[][][]): Record<string, string> {
  return {
    geometry: JSON.stringify({ rings }),
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
  };
}

export function pointGeometryParams(lat: number, lon: number): Record<string, string> {
  return {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
  };
}

export function envelopeGeometryParams(rings: number[][][]): Record<string, string> {
  const points = rings.flat();
  const xs = points.map((p) => p[0]!);
  const ys = points.map((p) => p[1]!);
  return {
    geometry: JSON.stringify({
      xmin: Math.min(...xs), ymin: Math.min(...ys),
      xmax: Math.max(...xs), ymax: Math.max(...ys),
      spatialReference: { wkid: 4326 },
    }),
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
  };
}

export function stringAttribute(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function numberAttribute(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
