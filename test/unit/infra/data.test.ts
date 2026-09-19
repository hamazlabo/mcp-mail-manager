import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

function synth(stage: 'dev' | 'prod') {
  const app = new App({ context: { stage } });
  return Template.fromStack(new MailMcpStack(app, resolveStage(app)));
}

// 初回の synth はアセット（autoDeleteObjects のカスタムリソース）のステージングで数秒かかるため一度だけ行う
const templates = {} as Record<'dev' | 'prod', Template>;
const template = (stage: 'dev' | 'prod') => templates[stage];

describe('data layer (DynamoDB / S3 / Secrets Manager)', () => {
  beforeAll(() => {
    templates.dev = synth('dev');
    templates.prod = synth('prod');
  }, 60_000);

  it('defines MailTable-<stage> with ttl attribute and PITR', () => {
    template('dev').hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'MailTable-dev',
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  it('has exactly two GSIs named GSI1 and GSI2', () => {
    template('dev').hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['id', 'uid', 'seen', 'flagged'] },
        }),
        Match.objectLike({
          IndexName: 'GSI2',
          KeySchema: [
            { AttributeName: 'GSI2PK', KeyType: 'HASH' },
            { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
    });
  });

  it('blocks public access, encrypts with SSE-S3 and expires raw messages after 365 days', () => {
    const t = template('dev');
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [Match.objectLike({ ExpirationInDays: 365, Status: 'Enabled' })],
      },
    });
    // enforceSSL: aws:SecureTransport=false を Deny するバケットポリシー
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('creates the mail secret mail-mcp/<stage>/mail with a placeholder', () => {
    template('dev').hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'mail-mcp/dev/mail',
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'password' }),
    });
  });

  it('retains table and bucket in prod, destroys them in dev', () => {
    const prod = template('prod');
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    prod.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    prod.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'MailTable-prod' });
    prod.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'mail-mcp/prod/mail' });

    const dev = template('dev');
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    dev.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  });

  it('exports MailSecretArn, TableName and BucketName', () => {
    const t = template('dev');
    t.hasOutput('MailSecretArn', {});
    t.hasOutput('TableName', {});
    t.hasOutput('BucketName', {});
  });
});
