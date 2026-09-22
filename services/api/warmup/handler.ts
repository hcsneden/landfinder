import type { APIGatewayProxyResult } from 'aws-lambda';
import { query } from '../shared/db';
import { success } from '../shared/response';

// Two callers:
//  - EventBridge, every 12 hours, so the Aurora Serverless writer never sits
//    paused long enough to fall into the slower deep-sleep resume.
//  - GET /warmup from the web app on load, so the resume (about 20 seconds from
//    a normal pause) happens while the user is still typing rather than inside
//    their first search, where it would run up against the API Gateway timeout.
export async function handler(): Promise<APIGatewayProxyResult> {
  const start = Date.now();
  await query('SELECT 1');
  return success({ ready: true, resumeMs: Date.now() - start });
}
