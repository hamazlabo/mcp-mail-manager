import { App, Aws, CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export type Stage = 'dev' | 'prod';
const STAGES: readonly string[] = ['dev', 'prod'];

/** 憲法 1 章: リージョンは ap-northeast-1 を既定とする。 */
export const REGION = 'ap-northeast-1';

export interface MailMcpStackProps extends StackProps {
  stage: Stage;
}

/** `--context stage=dev|prod` を検証して返す。未指定・不正はエラー。 */
export function resolveStage(app: App): MailMcpStackProps {
  const stage = app.node.tryGetContext('stage');
  if (typeof stage !== 'string' || !STAGES.includes(stage)) {
    throw new Error(
      `context "stage" must be one of [${STAGES.join(', ')}] (got: ${String(stage)}). ` +
        'Run: npx cdk deploy --all --context stage=dev',
    );
  }
  return { stage: stage as Stage };
}

export class MailMcpStack extends Stack {
  /** DynamoDB 単一テーブル（design.md 4 章） */
  readonly table: dynamodb.Table;
  /** 生メッセージ (RFC 5322) バケット */
  readonly bucket: s3.Bucket;
  /** IMAP / SMTP 認証情報。値は人間が設定する（design.md 5 章） */
  readonly mailSecret: secretsmanager.Secret;

  constructor(scope: Construct, props: MailMcpStackProps) {
    super(scope, `MailMcp-${props.stage}`, {
      ...props,
      stackName: `MailMcp-${props.stage}`,
      env: { region: REGION, account: process.env.CDK_DEFAULT_ACCOUNT },
    });
    const { stage } = props;
    const isProd = stage === 'prod';
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.table = new dynamodb.Table(this, 'MailTable', {
      tableName: `MailTable-${stage}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy,
    });
    // GSI1: フォルダ内 UID 集合（同期の照合）。射影は照合に要る属性のみ
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['id', 'uid', 'seen', 'flagged'],
    });
    // GSI2: 受信日時順の一覧 / 予約一覧
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.bucket = new s3.Bucket(this, 'RawBucket', {
      bucketName: `mail-mcp-raw-${stage}-${Aws.ACCOUNT_ID}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(365) }],
      removalPolicy,
      autoDeleteObjects: !isProd,
    });

    this.mailSecret = new secretsmanager.Secret(this, 'MailSecret', {
      secretName: `mail-mcp/${stage}/mail`,
      description: 'IMAP / SMTP credentials (domain, user, password, optional hosts). Set the value manually.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ domain: 'example.net', user: 'someone' }),
        generateStringKey: 'password',
      },
    });

    new CfnOutput(this, 'MailSecretArn', { value: this.mailSecret.secretArn });
    new CfnOutput(this, 'TableName', { value: this.table.tableName });
    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
  }
}
