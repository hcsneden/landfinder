import type { Parcel } from '@lastbestland/shared';

export interface ParcelRow {
  id: string;
  state: string;
  county: string | null;
  parcel_number: string | null;
  geo_id: string | null;
  address: string | null;
  acreage: number | null;
  building_value: number | null;
  prop_type: string | null;
  longitude: number | null;
  latitude: number | null;
  boundary: string | null;
  created_at: string;
  updated_at: string;
}

const SCALAR_COLUMNS = [
  'id', 'state', 'county', 'parcel_number', 'geo_id', 'address', 'acreage',
  'building_value', 'prop_type', 'created_at', 'updated_at',
];

/** Column list that selects a `ParcelRow` from the `parcels` table, optionally qualified by a table alias. */
export function parcelColumns(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return [
    ...SCALAR_COLUMNS.map((column) => `${prefix}${column}`),
    `ST_X(${prefix}coordinates::geometry) AS longitude`,
    `ST_Y(${prefix}coordinates::geometry) AS latitude`,
    `ST_AsGeoJSON(${prefix}boundary)::text AS boundary`,
  ].join(', ');
}

export function toParcel(row: ParcelRow): Parcel {
  return {
    id: row.id,
    state: row.state,
    county: row.county,
    parcelNumber: row.parcel_number,
    geoId: row.geo_id,
    address: row.address,
    acreage: row.acreage,
    buildingValue: row.building_value,
    propType: row.prop_type,
    coordinates:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude }
        : null,
    boundary: row.boundary ? (JSON.parse(row.boundary) as Parcel['boundary']) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
