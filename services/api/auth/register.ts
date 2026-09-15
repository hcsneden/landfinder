import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminInitiateAuthCommand,
  AuthFlowType,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { created, badRequest, serverError, error } from '../shared/response';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { AuthTokens, User, RegisterRequest } from '@landfinder/shared';

const USER_POOL_ID = process.env.USER_POOL_ID;
if (!USER_POOL_ID) throw new Error('USER_POOL_ID environment variable not set');

const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID;
if (!USER_POOL_CLIENT_ID) throw new Error('USER_POOL_CLIENT_ID environment variable not set');

const USERS_TABLE = process.env.USERS_TABLE;
if (!USERS_TABLE) throw new Error('USERS_TABLE environment variable not set');

const cognitoClient = tracer.captureAWSv3Client(new CognitoIdentityProviderClient({}));
const dynamoClient = tracer.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password: string): boolean {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    if (!event.body) {
      return badRequest('Request body is required');
    }

    let parsed: RegisterRequest;
    try {
      parsed = JSON.parse(event.body) as RegisterRequest;
    } catch {
      return badRequest('Invalid JSON in request body');
    }

    const { email, password } = parsed;

    if (!email || !password) {
      return badRequest('Email and password are required');
    }

    if (!isValidEmail(email)) {
      return badRequest('Invalid email format');
    }

    if (!isValidPassword(password)) {
      return badRequest('Password must be at least 8 characters with uppercase, lowercase, and number');
    }

    const createResult = await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: MessageActionType.SUPPRESS,
      })
    );

    const userId = createResult.User?.Username;
    if (!userId) {
      return serverError('Failed to create user');
    }

    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      })
    );

    const authResult = await cognitoClient.send(
      new AdminInitiateAuthCommand({
        UserPoolId: USER_POOL_ID,
        ClientId: USER_POOL_CLIENT_ID,
        AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );

    if (!authResult.AuthenticationResult) {
      return serverError('Failed to authenticate new user');
    }

    const { AccessToken, RefreshToken, ExpiresIn, IdToken } = authResult.AuthenticationResult;

    if (!AccessToken || !RefreshToken || !IdToken) {
      return serverError('Failed to generate tokens');
    }

    const tokenParts = IdToken.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1]!, 'base64').toString()) as { sub?: string };
    const cognitoSub = payload.sub;

    if (!cognitoSub) {
      return serverError('Invalid token: missing user identifier');
    }

    const now = new Date().toISOString();

    const user: User = { id: cognitoSub, email, createdAt: now };

    await docClient.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: { userId: cognitoSub, email, createdAt: now, updatedAt: now },
      })
    );

    const tokens: AuthTokens = {
      accessToken: AccessToken,
      idToken: IdToken,
      refreshToken: RefreshToken,
      expiresIn: ExpiresIn ?? 3600,
    };

    metrics.addMetric('RegistrationSucceeded', MetricUnit.Count, 1);
    logger.info('Registration succeeded', { userId: cognitoSub });

    return created({ tokens, user });
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'UsernameExistsException') {
        return error(409, 'USER_EXISTS', 'An account with this email already exists');
      }
      if (err.name === 'InvalidPasswordException') {
        return badRequest('Password does not meet requirements');
      }
    }

    logger.error('Registration error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred during registration');
  } finally {
    metrics.publishStoredMetrics();
  }
}
