import { Pool } from 'pg';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { tracer } from './tracer';

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
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: {
      rejectUnauthorized: true,
    },
  });

  return pool;
}

async function withDbSubsegment<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment(`## db.${operation}`);
  try {
    return await fn();
  } catch (err) {
    subsegment?.addErrorFlag();
    throw err;
  } finally {
    subsegment?.close();
  }
}

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  return withDbSubsegment('query', async () => {
    const pool = await getPool();
    const result = await pool.query(sql, params);
    return result.rows as T[];
  });
}

export async function queryOne<T>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] || null;
}

export async function execute(
  sql: string,
  params?: unknown[]
): Promise<number> {
  return withDbSubsegment('execute', async () => {
    const pool = await getPool();
    const result = await pool.query(sql, params);
    return result.rowCount || 0;
  });
}
