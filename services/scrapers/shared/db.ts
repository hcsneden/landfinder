import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

interface DatabaseCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

let pool: Pool | null = null;
let credentials: DatabaseCredentials | null = null;

const secretsClient = new SecretsManagerClient({});

async function getCredentials(): Promise<DatabaseCredentials> {
  if (credentials) {
    return credentials;
  }

  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) {
    throw new Error('DATABASE_SECRET_ARN environment variable not set');
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = await secretsClient.send(command);

  if (!response.SecretString) {
    throw new Error('Failed to retrieve database credentials');
  }

  credentials = JSON.parse(response.SecretString);
  return credentials!;
}

export async function getPool(): Promise<Pool> {
  if (pool) {
    return pool;
  }

  const creds = await getCredentials();

  pool = new Pool({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.dbname,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: {
      rejectUnauthorized: true,
    },
  });

  return pool;
}

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function execute(sql: string, params?: unknown[]): Promise<number> {
  const pool = await getPool();
  const result = await pool.query(sql, params);
  return result.rowCount || 0;
}

export async function upsertParcel(parcel: {
  state: string;
  county: string | null;
  parcelNumber: string;
  geoId: string | null;
  address: string | null;
  acreage: number | null;
  latitude: number | null;
  longitude: number | null;
  boundaryGeoJson: string | null;
}): Promise<string> {
  // Build params and SQL placeholders together so indices are always in sync.
  const params: unknown[] = [
    parcel.state,      // $1
    parcel.county,     // $2
    parcel.parcelNumber, // $3
    parcel.geoId,      // $4
    parcel.address,    // $5
    parcel.acreage,    // $6
  ];

  let coordsSql: string;
  if (parcel.latitude != null && parcel.longitude != null) {
    params.push(parcel.longitude, parcel.latitude); // ST_MakePoint(lng, lat) = (x, y)
    coordsSql = `ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)`;
  } else {
    coordsSql = 'NULL';
  }

  let boundarySql: string;
  if (parcel.boundaryGeoJson != null) {
    params.push(parcel.boundaryGeoJson);
    boundarySql = `ST_GeomFromGeoJSON($${params.length})`;
  } else {
    boundarySql = 'NULL';
  }

  const sql = `
    INSERT INTO parcels (
      state, county, parcel_number, geo_id, address, acreage,
      coordinates, boundary, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, ${coordsSql}, ${boundarySql}, NOW(), NOW())
    ON CONFLICT (state, parcel_number)
    DO UPDATE SET
      county = EXCLUDED.county,
      geo_id = EXCLUDED.geo_id,
      address = EXCLUDED.address,
      acreage = EXCLUDED.acreage,
      coordinates = EXCLUDED.coordinates,
      boundary = EXCLUDED.boundary,
      updated_at = NOW()
    RETURNING id
  `;

  const result = await query<{ id: string }>(sql, params);
  return result[0].id;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
