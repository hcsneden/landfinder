import { execute } from '../shared/db';
import { logger } from '../shared/logger';
import { splitStatements } from '../shared/sql';
import initialSchema from '../../../database/001_initial_schema.sql';
import huntingAndStreams from '../../../database/002_hunting_stream_schema.sql';
import enrichmentCache from '../../../database/003_enrichment_cache.sql';
import dropLegacy from '../../../database/004_drop_legacy.sql';

// Every migration is idempotent, so the full list runs on each invocation.
const MIGRATIONS = [initialSchema, huntingAndStreams, enrichmentCache, dropLegacy];

// The Data API runs one statement per call.
export async function handler(): Promise<{ statusCode: number; body: string }> {
  const statements = MIGRATIONS.flatMap(splitStatements);
  logger.info('Running schema migration', { statements: statements.length });
  for (const statement of statements) {
    await execute(statement);
  }
  logger.info('Migration completed');
  return { statusCode: 200, body: 'Migration completed' };
}
