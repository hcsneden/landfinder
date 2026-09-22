import type { HuntingDistrict } from '@lastbestland/shared';
import { query } from '../../shared/db';

interface DistrictRow {
  id: string;
  district_number: string;
  species: string;
}

// Districts intersecting the parcel boundary, or a 100 meter circle around the
// parcel point when no boundary is stored.
export async function getHuntingDistricts(parcelId: string): Promise<HuntingDistrict[]> {
  const rows = await query<DistrictRow>(
    `SELECT hd.id, hd.district_number, hd.species
     FROM hunting_districts hd
     JOIN parcels p ON p.id = $1::uuid
     WHERE ST_Intersects(hd.boundary, COALESCE(p.boundary, ST_Buffer(p.coordinates, 100)))
     ORDER BY hd.species, hd.district_number`,
    [parcelId]
  );
  return rows.map((row) => ({ id: row.id, districtNumber: row.district_number, species: row.species }));
}
