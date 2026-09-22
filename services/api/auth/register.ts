import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  MessageActionType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { RegisterRequest } from '@lastbestland/shared';
import { cognitoClient, authenticateWithPassword } from '../shared/cognito';
import { env } from '../shared/env';
import { created, badRequest, serverError, error } from '../shared/response';
import { parseJsonBody } from '../shared/request';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';

/**
 * Creates the user with the email already marked verified and signs them in.
 * This skips the confirmation-code step so the demo has no email dependency.
 * A production sign-up would use SignUp and ConfirmSignUp instead.
 */
export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const body = parseJsonBody<RegisterRequest>(event);
    if (!body?.email || !body.password) return badRequest('Email and password are required');
    const { email, password } = body;

    await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: env.userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        MessageAction: MessageActionType.SUPPRESS,
      })
    );
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({ UserPoolId: env.userPoolId, Username: email, Password: password, Permanent: true })
    );

    const session = await authenticateWithPassword(email, password);
    if (!session) return serverError('Failed to sign in the new user');

    metrics.addMetric('RegistrationSucceeded', MetricUnit.Count, 1);
    logger.info('Registration succeeded', { userId: session.user.id });
    return created(session);
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'UsernameExistsException') return error(409, 'USER_EXISTS', 'An account with this email already exists');
      if (err.name === 'InvalidPasswordException') return badRequest('Password must be at least 8 characters with uppercase, lowercase, and a number');
      if (err.name === 'InvalidParameterException') return badRequest('Invalid email address');
    }
    logger.error('Registration error', { error: String(err) });
    return serverError('An error occurred during registration');
  } finally {
    metrics.publishStoredMetrics();
  }
}
