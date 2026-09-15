import {
  RDSDataClient,
  ExecuteStatementCommand,
  type ArrayValue,
  type ColumnMetadata,
  type ExecuteStatementCommandInput,
  type Field,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { tracer } from './tracer';

// The API Lambdas run outside the VPC and reach Aurora through the RDS Data API,
// so there is no connection pool and no NAT. Callers keep writing pg-style SQL
// with $1, $2 placeholders. toDataApiStatement translates it.

const client = new RDSDataClient({});

// Aurora pauses when idle. The first request after a pause gets
// DatabaseResumingException for roughly 15 seconds, so retry within the
// API Gateway timeout.
const RESUME_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000, 5000];

function databaseTarget(): Pick<ExecuteStatementCommandInput, 'resourceArn' | 'secretArn' | 'database'> {
  const resourceArn = process.env.DATABASE_CLUSTER_ARN;
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!resourceArn || !secretArn) {
    throw new Error('DATABASE_CLUSTER_ARN and DATABASE_SECRET_ARN environment variables must be set');
  }
  return { resourceArn, secretArn, database: process.env.DATABASE_NAME ?? 'landfinder' };
}

// Postgres array literal. The Data API has no array parameters, so arrays are
// sent as text and the SQL casts them, e.g. $2::text[].
function toArrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

function toParameter(name: string, value: unknown): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === 'boolean') return { name, value: { booleanValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  if (value instanceof Date) {
    return {
      name,
      value: { stringValue: value.toISOString().replace('T', ' ').replace('Z', '') },
      typeHint: 'TIMESTAMP',
    };
  }
  if (Array.isArray(value)) return { name, value: { stringValue: toArrayLiteral(value) } };
  if (typeof value === 'object') return { name, value: { stringValue: JSON.stringify(value) } };
  return { name, value: { stringValue: String(value) } };
}

export function toDataApiStatement(
  sql: string,
  params: unknown[] = []
): { sql: string; parameters: SqlParameter[] } {
  return {
    sql: sql.replace(/\$(\d+)/g, (_, n) => `:p${n}`),
    parameters: params.map((value, i) => toParameter(`p${i + 1}`, value)),
  };
}

// Decode values the way node-postgres did, so callers see the same JS types:
// timestamps and dates as Date, json as parsed objects, int8 and numeric as strings.
function decodeScalar(value: string | number | boolean, typeName: string): unknown {
  switch (typeName) {
    case 'json':
    case 'jsonb':
      return JSON.parse(value as string);
    case 'timestamptz':
    case 'timestamp':
      return new Date(`${String(value).replace(' ', 'T')}Z`);
    case 'date':
      return new Date(`${value}T00:00:00Z`);
    case 'int8':
    case 'numeric':
      return String(value);
    default:
      return value;
  }
}

function decodeArray(array: ArrayValue, typeName: string): unknown[] {
  const values = array.arrayValues ?? array.stringValues ?? array.longValues ?? array.doubleValues ?? array.booleanValues ?? [];
  return values.map((v) =>
    array.arrayValues ? decodeArray(v as ArrayValue, typeName) : decodeScalar(v as string | number | boolean, typeName)
  );
}

function decodeField(field: Field, column: ColumnMetadata): unknown {
  const typeName = (column.typeName ?? '').toLowerCase();
  if (field.isNull) return null;
  if (field.arrayValue) return decodeArray(field.arrayValue, typeName.replace(/^_/, ''));
  if (field.stringValue !== undefined) return decodeScalar(field.stringValue, typeName);
  if (field.longValue !== undefined) return decodeScalar(field.longValue, typeName);
  if (field.doubleValue !== undefined) return decodeScalar(field.doubleValue, typeName);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
  return null;
}

export function decodeRecords<T>(records: Field[][] = [], columns: ColumnMetadata[] = []): T[] {
  return records.map(
    (record) =>
      Object.fromEntries(record.map((field, i) => [columns[i]?.label ?? columns[i]?.name ?? `column${i}`, decodeField(field, columns[i] ?? {})])) as T
  );
}

async function run(sql: string, params: unknown[] | undefined, includeRecords: boolean) {
  const statement = toDataApiStatement(sql, params);
  const input: ExecuteStatementCommandInput = {
    ...databaseTarget(),
    ...statement,
    includeResultMetadata: includeRecords,
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.send(new ExecuteStatementCommand(input));
    } catch (err) {
      const delay = RESUME_RETRY_DELAYS_MS[attempt];
      if ((err as Error).name !== 'DatabaseResumingException' || delay === undefined) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
    const result = await run(sql, params, true);
    return decodeRecords<T>(result.records, result.columnMetadata);
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
    const result = await run(sql, params, false);
    return result.numberOfRecordsUpdated ?? 0;
  });
}
