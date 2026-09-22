import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from './query';

describe('buildSearchQuery', () => {
  it('always filters by state and binds parameters in order', () => {
    const { sql, params } = buildSearchQuery({ state: 'MT' });
    expect(sql).toContain('p.state = $1');
    expect(params).toEqual(['MT']);
  });

  it('adds one parameter per criterion', () => {
    const { sql, params } = buildSearchQuery({
      state: 'MT',
      county: 'Gallatin',
      minAcreage: 5,
      maxAcreage: 40,
      minPrice: 100_000,
      maxPrice: 900_000,
      bbox: { minLng: -111.5, minLat: 45.5, maxLng: -110.5, maxLat: 46 },
    });
    expect(params).toEqual(['MT', 'Gallatin', 5, 40, 100_000, 900_000, -111.5, 45.5, -110.5, 46]);
    expect(sql).toContain('ls.price >= $5');
    expect(sql).toContain('ST_MakeEnvelope($7, $8, $9, $10, 4326)');
  });

  it('uses EXISTS for the water rights filter so parcels are not duplicated', () => {
    const { sql } = buildSearchQuery({ state: 'MT', waterRightsRequired: true });
    expect(sql).toContain('EXISTS (SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id)');
    expect(sql).not.toContain('GROUP BY');
  });
});
