import { describe, expect, it } from 'vitest';
import { hasPublicRoadAccess, isMaintainedRoad, isPublicRoad } from './roads';
import type { RoadSegment } from './types';

const segment = (type: RoadSegment['type']): RoadSegment => ({
  name: null,
  type,
  source: 'tiger',
  surfaceType: null,
  maintLevel: null,
});

describe('road classification', () => {
  it('treats trails and unknown roads as non-public', () => {
    expect(isPublicRoad('trail')).toBe(false);
    expect(isPublicRoad('unknown')).toBe(false);
    expect(isPublicRoad('forest')).toBe(true);
  });

  it('counts only highway, county, and local roads as maintained', () => {
    expect(isMaintainedRoad('county')).toBe(true);
    expect(isMaintainedRoad('forest')).toBe(false);
  });

  it('reports public access when any segment is public', () => {
    expect(hasPublicRoadAccess([segment('trail'), segment('blm')])).toBe(true);
    expect(hasPublicRoadAccess([segment('trail')])).toBe(false);
    expect(hasPublicRoadAccess([])).toBe(false);
  });
});
