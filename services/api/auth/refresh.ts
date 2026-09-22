import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { RefreshRequest } from '@lastbestland/shared';
import { refreshSession, isInvalidCredentialsError } from '../shared/cognito';
import { success, badRequest, unauthorized, serverError } from '../shared/response';
import { parseJsonBody } from '../shared/request';
import { logger } from '../shared/logger';

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const body = parseJsonBody<RefreshRequest>(event);
    if (!body?.refreshToken) return badRequest('refreshToken is required');

    const session = await refreshSession(body.refreshToken);
    if (!session) return unauthorized('Session expired');
    return success(session);
  } catch (err) {
    if (isInvalidCredentialsError(err)) return unauthorized('Session expired');
    logger.error('Refresh error', { error: String(err) });
    return serverError('An error occurred refreshing the session');
  }
}
