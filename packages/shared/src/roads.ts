import type { RoadSegment, RoadType } from './types';

const PUBLIC_ROAD_TYPES: ReadonlySet<RoadType> = new Set(['highway', 'county', 'local', 'forest', 'blm']);

/** Road types that a passenger vehicle can normally use without high clearance. */
const MAINTAINED_ROAD_TYPES: ReadonlySet<RoadType> = new Set(['highway', 'county', 'local']);

export function isPublicRoad(type: RoadType): boolean {
  return PUBLIC_ROAD_TYPES.has(type);
}

export function isMaintainedRoad(type: RoadType): boolean {
  return MAINTAINED_ROAD_TYPES.has(type);
}

export function hasPublicRoadAccess(segments: RoadSegment[]): boolean {
  return segments.some((segment) => isPublicRoad(segment.type));
}
