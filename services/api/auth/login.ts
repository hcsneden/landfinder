import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { LoginRequest } from '@lastbestland/shared';
import { authenticateWithPassword, isInvalidCredentialsError } from '../shared/cognito';
import { success, badRequest, unauthorized, serverError } from '../shared/response';
import { parseJsonBody } from '../shared/request';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const body = parseJsonBody<LoginRequest>(event);
    if (!body?.email || !body.password) return badRequest('Email and password are required');

    const session = await authenticateWithPassword(body.email, body.password);
    if (!session) return unauthorized('Invalid credentials');

    metrics.addMetric('LoginSucceeded', MetricUnit.Count, 1);
    logger.info('Login succeeded', { userId: session.user.id });
    return success(session);
  } catch (err) {
    if (isInvalidCredentialsError(err)) {
      metrics.addMetric('LoginFailed', MetricUnit.Count, 1);
      return unauthorized('Invalid email or password');
    }
    logger.error('Login error', { error: String(err) });
    return serverError('An error occurred during login');
  } finally {
    metrics.publishStoredMetrics();
  }
}
