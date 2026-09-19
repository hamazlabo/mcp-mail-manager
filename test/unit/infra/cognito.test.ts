import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

// 初回の synth はアセットのステージングで数秒かかるため一度だけ行う
let template: Template;

describe('Cognito (User Pool / domain / app client / smoke user)', () => {
  beforeAll(() => {
    const app = new App({ context: { stage: 'dev' } });
    template = Template.fromStack(new MailMcpStack(app, resolveStage(app)));
  }, 60_000);

  it('disables self sign-up (admin creates users only)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AliasAttributes: ['email'],
    });
  });

  it('registers a public app client with PKCE code flow, both callback URLs and USER_PASSWORD_AUTH', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
      CallbackURLs: ['http://localhost:8765/callback', 'https://claude.ai/api/mcp/auth_callback'],
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
      PreventUserExistenceErrors: 'ENABLED',
    });
  });

  it('uses the newer managed login with a Cognito domain prefix and default branding', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['mail-mcp-dev-'])]) }),
      ManagedLoginVersion: 2,
    });
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: true,
    });
  });

  it('creates the smoke user secret and the AdminCreateUser / AdminSetUserPassword custom resources', () => {
    // パスワードは JSON ではなく生の文字列で保存する（カスタムリソースでは JSON のキーを取り出せないため）
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'mail-mcp/dev/smoke-user-password',
      GenerateSecretString: Match.objectLike({ PasswordLength: 24 }),
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'mail-mcp/dev/smoke-user-password',
      GenerateSecretString: Match.not(Match.objectLike({ GenerateStringKey: Match.anyValue() })),
    });
    // Create は SDK 呼出の JSON 文字列（Ref を含むので Fn::Join）。文字列部分だけ連結して検査する
    const resources = Object.values(template.findResources('Custom::AWS'));
    const joinParts = (r: any): unknown[] => {
      const c = r.Properties.Create;
      return typeof c === 'string' ? [c] : c['Fn::Join'][1];
    };
    const creates = resources.map((r) => joinParts(r).filter((p): p is string => typeof p === 'string').join(''));
    expect(creates.some((c) => c.includes('"action":"AdminCreateUserCommand"') && c.includes('"MessageAction":"SUPPRESS"'))).toBe(true);
    // 動的参照 {{resolve:secretsmanager:...}} はカスタムリソースでは解決されない（CloudFormation の制約）。
    // GetSecretValue のカスタムリソースの応答（GetAtt SecretString）を AdminSetUserPassword に渡す
    expect(creates.some((c) => c.includes('"action":"GetSecretValueCommand"'))).toBe(true);
    const setPassword = resources.find((r) => joinParts(r).some((p) => typeof p === 'string' && p.includes('"action":"AdminSetUserPasswordCommand"')));
    expect(setPassword).toBeDefined();
    const setPasswordText = joinParts(setPassword).filter((p): p is string => typeof p === 'string').join('');
    expect(setPasswordText).toContain('"Permanent":true');
    expect(setPasswordText).not.toContain('{{resolve:');
    expect(JSON.stringify(setPassword!.Properties.Create)).toMatch(/"Fn::GetAtt":\["SmokeUserPasswordRead[A-Za-z0-9]*","SecretString"\]/);
    // Cognito 権限は User Pool の ARN に限定
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword']),
            Resource: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith(['Arn']) }),
          }),
        ]),
      },
    });
  });

  it('registers the MCP URL as a Cognito resource server so RFC 8707 resource requests are accepted', () => {
    // MCP クライアントは authorize / token に resource=<McpUrl> を付ける。Cognito は未登録の resource を invalid_grant で拒否する
    template.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      UserPoolId: { Ref: Match.stringLikeRegexp('UserPool') },
      Identifier: { 'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [Match.stringLikeRegexp('Facade'), 'DomainName'] }, '/mcp']] },
      Scopes: Match.arrayWith([Match.objectLike({ ScopeName: 'access' })]),
    });
  });

  it('exports UserPoolId, UserPoolClientId, CognitoDomain and SmokeUserSecretArn', () => {
    template.hasOutput('UserPoolId', {});
    template.hasOutput('UserPoolClientId', {});
    template.hasOutput('CognitoDomain', {});
    template.hasOutput('SmokeUserSecretArn', {});
  });
});
