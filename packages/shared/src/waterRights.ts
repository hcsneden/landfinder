import type { WaterRightStatus, WaterType } from './types';

/** Maps a DNRC WR_STATUS value such as "ACTIVE" or "TERMINATED" to a normalized status. */
export function parseWaterRightStatus(raw: unknown): WaterRightStatus {
  const status = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (status.includes('INACTIVE') || status.includes('TERMINATED') || status.includes('ABANDONED') || status.includes('REVOKED')) {
    return 'inactive';
  }
  if (status.includes('ACTIVE')) return 'active';
  if (status.includes('PENDING') || status.includes('APPLICATION')) return 'pending';
  return 'unknown';
}

/** Maps a DNRC SOURCE_TYPES value such as "SURFACE WATER, GROUNDWATER" to a water type. */
export function parseWaterType(raw: unknown): WaterType {
  const sourceTypes = typeof raw === 'string' ? raw.toUpperCase() : '';
  const hasGround = sourceTypes.includes('GROUND');
  const hasSurface = sourceTypes.includes('SURFACE');
  if (hasGround && hasSurface) return 'mixed';
  if (hasGround) return 'groundwater';
  return 'surface';
}

/**
 * Returns a YYYY-MM-DD priority date from the ArcGIS epoch-millisecond field,
 * falling back to the text date field when the numeric one is missing.
 */
export function parsePriorityDate(epochMs: unknown, fallbackText: unknown): string | null {
  if (typeof epochMs === 'number') return toIsoDate(new Date(epochMs));
  if (typeof fallbackText === 'string' && fallbackText) {
    const parsed = new Date(fallbackText);
    if (!Number.isNaN(parsed.getTime())) return toIsoDate(parsed);
  }
  return null;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
