import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AuthFlowType,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AuthSession, AuthTokens, User } from '@lastbestland/shared';
import { env } from './env';
import { tracer } from './tracer';

export const cognitoClient = tracer.captureAWSv3Client(new CognitoIdentityProviderClient({}));

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export async function authenticateWithPassword(email: string, password: string): Promise<AuthSession | null> {
  const result = await cognitoClient.send(
    new AdminInitiateAuthCommand({
      UserPoolId: env.userPoolId,
      ClientId: env.userPoolClientId,
      AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    })
  );
  return toSession(result.AuthenticationResult, null);
}

/**
 * Exchanges a refresh token for new access and ID tokens. Cognito does not
 * return a new refresh token, so the caller keeps the one it has.
 */
export async function refreshSession(refreshToken: string): Promise<AuthSession | null> {
  const result = await cognitoClient.send(
    new AdminInitiateAuthCommand({
      UserPoolId: env.userPoolId,
      ClientId: env.userPoolClientId,
      AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
  );
  return toSession(result.AuthenticationResult, refreshToken);
}

function toSession(result: AuthenticationResultType | undefined, existingRefreshToken: string | null): AuthSession | null {
  const refreshToken = result?.RefreshToken ?? existingRefreshToken;
  if (!result?.AccessToken || !result.IdToken || !refreshToken) return null;

  const claims = decodeJwtPayload(result.IdToken);
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') return null;

  const tokens: AuthTokens = {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken,
    expiresIn: result.ExpiresIn ?? DEFAULT_EXPIRES_IN_SECONDS,
  };
  const user: User = { id: claims.sub, email: claims.email };
  return { tokens, user };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
}

export function isInvalidCredentialsError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'NotAuthorizedException' || err.name === 'UserNotFoundException');
}
