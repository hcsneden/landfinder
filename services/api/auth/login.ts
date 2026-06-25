import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AuthFlowType,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { success, badRequest, unauthorized, serverError } from '../shared/response';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { AuthTokens, User, LoginRequest } from '@landfinder/shared';

const USER_POOL_ID = process.env.USER_POOL_ID;
if (!USER_POOL_ID) throw new Error('USER_POOL_ID environment variable not set');

const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
if (!USER_POOL_CLIENT_ID) throw new Error('USER_POOL_CLIENT_ID environment variable not set');

const USERS_TABLE = process.env.USERS_TABLE;
if (!USERS_TABLE) throw new Error('USERS_TABLE environment variable not set');

const cognitoClient = tracer.captureAWSv3Client(new CognitoIdentityProviderClient({}));
const dynamoClient = tracer.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let parsed: LoginRequest;
    try {
      parsed = JSON.parse(event.body) as LoginRequest;
    } catch {
      return badRequest('Invalid JSON in request body');
    }

    const { email, password } = parsed;

    if (!email || !password) {
      return badRequest('Email and password are required');
    }

    const authResult = await cognitoClient.send(
      new AdminInitiateAuthCommand({
        UserPoolId: USER_POOL_ID,
        ClientId: USER_POOL_CLIENT_ID,
        AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );

    if (!authResult.AuthenticationResult) {
      return unauthorized('Invalid credentials');
    }

    const { AccessToken, RefreshToken, ExpiresIn, IdToken } = authResult.AuthenticationResult;

    if (!AccessToken || !RefreshToken || !IdToken) {
      return serverError('Failed to generate tokens');
    }

    const tokenParts = IdToken.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString()) as { sub?: string };
    const userId = payload.sub;

    if (!userId) {
      return serverError('Invalid token: missing user identifier');
    }

    const userResult = await docClient.send(
      new GetCommand({ TableName: USERS_TABLE, Key: { userId } })
    );

    const user: User = userResult.Item
      ? { id: userResult.Item.userId, email: userResult.Item.email, createdAt: userResult.Item.createdAt }
      : { id: userId, email, createdAt: new Date().toISOString() };

    const tokens: AuthTokens = {
      accessToken: AccessToken,
      idToken: IdToken,
      refreshToken: RefreshToken,
      expiresIn: ExpiresIn ?? 3600,
    };

    metrics.addMetric('LoginSucceeded', MetricUnit.Count, 1);
    logger.info('Login succeeded', { userId });

    return success({ tokens, user });
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'NotAuthorizedException' || err.name === 'UserNotFoundException') {
        metrics.addMetric('LoginFailed', MetricUnit.Count, 1);
        return unauthorized('Invalid email or password');
      }
    }

    logger.error('Login error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred during login');
  } finally {
    metrics.publishStoredMetrics();
  }
}
