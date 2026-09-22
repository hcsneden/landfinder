import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

interface DatabaseCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

// Amazon RDS certificate bundle, so the TLS connection to Aurora is verified.
const RDS_CA_BUNDLE = path.join(__dirname, '../certs/rds-global-bundle.pem');

let pool: Pool | null = null;

async function getCredentials(): Promise<DatabaseCredentials> {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) throw new Error('DATABASE_SECRET_ARN environment variable must be set');
  const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('Database secret has no value');
  return JSON.parse(response.SecretString) as DatabaseCredentials;
}

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const credentials = await getCredentials();
  pool = new Pool({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 25_000,
    ssl: { ca: readFileSync(RDS_CA_BUNDLE, 'utf8') },
  });
  return pool;
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await (await getPool()).query(sql, params);
  return result.rows as T[];
}

export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const result = await (await getPool()).query(sql, params);
  return result.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
