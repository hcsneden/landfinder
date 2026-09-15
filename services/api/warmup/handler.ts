import { query } from '../shared/db';

// Invoked on a schedule so the Aurora Serverless writer never sits paused long
// enough to fall into the slower deep-sleep resume.
export async function handler(): Promise<void> {
  await query('SELECT 1');
}
