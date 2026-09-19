import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { StackOutputs } from './outputs';

/** User Pool ID の接頭辞（`ap-northeast-1_xxxx`）からリージョンを得る */
export function regionOf(outputs: StackOutputs): string {
  return outputs.UserPoolId.split('_')[0];
}

/**
 * Secrets Manager の smoke ユーザで USER_PASSWORD_AUTH を行い、アクセストークンを返す（design.md 9 章）。
 * AWS 資格情報はデプロイジョブの OIDC ロール（またはローカルの AWS_PROFILE）。
 */
export async function getAccessToken(outputs: StackOutputs): Promise<string> {
  const region = regionOf(outputs);
  const secret = await new SecretsManagerClient({ region }).send(
    new GetSecretValueCommand({ SecretId: outputs.SmokeUserSecretArn }),
  );
  const { username, password } = JSON.parse(secret.SecretString ?? '{}') as { username: string; password: string };
  const auth = await new CognitoIdentityProviderClient({ region }).send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: outputs.UserPoolClientId,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );
  const token = auth.AuthenticationResult?.AccessToken;
  if (!token) throw new Error('InitiateAuth returned no access token');
  return token;
}
