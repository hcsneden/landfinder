import type { WaterRight, WaterRightStatus, WaterType } from '@lastbestland/shared';
import { query } from '../../shared/db';

interface WaterRightRow {
  id: string;
  parcel_id: string;
  water_right_number: string | null;
  water_source: string | null;
  water_type: WaterType | null;
  flow_rate: number | null;
  volume: number | null;
  priority_date: string | null;
  status: WaterRightStatus | null;
  raw_data: Record<string, unknown>;
  created_at: string;
}

export async function getWaterRights(parcelId: string): Promise<WaterRight[]> {
  const rows = await query<WaterRightRow>(
    `SELECT id, parcel_id, water_right_number, water_source, water_type, flow_rate, volume,
       priority_date::text AS priority_date, status, raw_data, created_at
     FROM water_rights WHERE parcel_id = $1::uuid
     ORDER BY priority_date ASC NULLS LAST`,
    [parcelId]
  );
  return rows.map((row) => ({
    id: row.id,
    parcelId: row.parcel_id,
    waterRightNumber: row.water_right_number,
    waterSource: row.water_source,
    waterType: row.water_type,
    flowRateGpm: row.flow_rate,
    volumeAcreFeet: row.volume,
    priorityDate: row.priority_date,
    status: row.status ?? 'unknown',
    rawData: row.raw_data,
    createdAt: row.created_at,
  }));
}
