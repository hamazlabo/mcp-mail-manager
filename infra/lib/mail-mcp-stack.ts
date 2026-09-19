import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { App, ArnFormat, Aws, CfnOutput, Duration, IgnoreMode, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { ScheduledSend } from './scheduled-send';
import { SyncJob } from './sync-job';

export type Stage = 'dev' | 'prod';
const STAGES: readonly string[] = ['dev', 'prod'];

/** 憲法 1 章: リージョンは ap-northeast-1 を既定とする。 */
export const REGION = 'ap-northeast-1';

/** 正常性テスト用 Cognito ユーザ（パスワードは Secrets Manager `mail-mcp/<stage>/smoke-user`） */
export const SMOKE_USERNAME = 'smoke';

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
  /** OAuth 2.1 認可サーバ（ADR-0004） */
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly userPoolDomain: cognito.UserPoolDomain;
  /** 正常性テスト用ユーザのパスワード */
  readonly smokeUserSecret: secretsmanager.Secret;
  /** MCP サーバのコンテナイメージ（デプロイ時に CodeBuild が ARM64 でビルド: ADR-0005） */
  readonly image: ContainerImageBuild;
  /** MCP サーバ本体（ADR-0001） */
  readonly runtime: agentcore.Runtime;
  /** 予約送信スケジュールのグループ名 `mail-mcp-<stage>` */
  readonly scheduleGroupName: string;
  /** EventBridge Scheduler がターゲット（scheduled-send Lambda）を起動するロール。invoke 権限は T-031 で付与 */
  readonly schedulerRole: iam.Role;
  /** scheduled-send Lambda の ARN（関数名の規約から先に決める。T-031 が同名で作る） */
  readonly scheduledSendFunctionArn: string;
  /** façade（ADR-0001）。Claude に登録する URL は `https://<domain>/mcp` */
  readonly distribution: cloudfront.Distribution;

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

    // ---- Cognito（ADR-0004: セルフサインアップ無効、公開クライアント + PKCE、Managed Login）----
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `mail-mcp-${stage}`,
      selfSignUpEnabled: false,
      // ユーザ名でも email でもサインインできる（smoke ユーザは固定ユーザ名、開発者は email）
      signInAliases: { username: true, email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: `mail-mcp-${stage}`,
      generateSecret: false,
      // USER_PASSWORD_AUTH は正常性テスト（InitiateAuth）用
      authFlows: { userPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['http://localhost:8765/callback', 'https://claude.ai/api/mcp/auth_callback'],
      },
      preventUserExistenceErrors: true,
    });
    const domainPrefix = `mail-mcp-${stage}-${Aws.ACCOUNT_ID}`;
    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    // 新しい Managed Login はブランディング設定が必須（Cognito 既定のデザインを使う）
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(this.userPoolDomain);

    // 正常性テスト用ユーザ: パスワードを生成して Secrets Manager に置き、AdminCreateUser → AdminSetUserPassword。
    // 動的参照 {{resolve:secretsmanager:...}} はカスタムリソースでは解決されない（CloudFormation の制約）ため、
    // GetSecretValue を別のカスタムリソースで呼び、その応答（GetAtt SecretString）を渡す。
    // CFN の組込関数では JSON のキーを取り出せないので、パスワードは生の文字列で保存する
    this.smokeUserSecret = new secretsmanager.Secret(this, 'SmokeUserPasswordSecret', {
      secretName: `mail-mcp/${stage}/smoke-user-password`,
      description: `Password of the Cognito user "${SMOKE_USERNAME}" for npm run test:smoke`,
      generateSecretString: { excludeCharacters: '"\'\\/@ ', passwordLength: 24 },
    });
    const readSmokePassword: cr.AwsSdkCall = {
      service: '@aws-sdk/client-secrets-manager',
      action: 'GetSecretValueCommand',
      parameters: { SecretId: this.smokeUserSecret.secretArn },
      physicalResourceId: cr.PhysicalResourceId.of(`mail-mcp-${stage}-smoke-user-password-read`),
      // 値をハンドラのログに出さない
      logging: cr.Logging.withDataHidden(),
    };
    const smokePasswordRead = new cr.AwsCustomResource(this, 'SmokeUserPasswordRead', {
      onCreate: readSmokePassword,
      onUpdate: readSmokePassword,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [this.smokeUserSecret.secretArn] }),
      ]),
      installLatestAwsSdk: false,
    });
    const cognitoAdmin = cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminSetUserPassword'],
        resources: [this.userPool.userPoolArn],
      }),
    ]);
    const createSmokeUser: cr.AwsSdkCall = {
      service: '@aws-sdk/client-cognito-identity-provider',
      action: 'AdminCreateUserCommand',
      parameters: {
        UserPoolId: this.userPool.userPoolId,
        Username: SMOKE_USERNAME,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: 'smoke@example.invalid' },
          { Name: 'email_verified', Value: 'true' },
        ],
      },
      physicalResourceId: cr.PhysicalResourceId.of(`mail-mcp-${stage}-smoke-user`),
      ignoreErrorCodesMatching: 'UsernameExistsException',
    };
    const smokeUser = new cr.AwsCustomResource(this, 'SmokeUser', {
      onCreate: createSmokeUser,
      onUpdate: createSmokeUser,
      policy: cognitoAdmin,
      installLatestAwsSdk: false,
    });
    const setSmokePassword: cr.AwsSdkCall = {
      service: '@aws-sdk/client-cognito-identity-provider',
      action: 'AdminSetUserPasswordCommand',
      parameters: {
        UserPoolId: this.userPool.userPoolId,
        Username: SMOKE_USERNAME,
        Password: smokePasswordRead.getResponseField('SecretString'),
        Permanent: true,
      },
      physicalResourceId: cr.PhysicalResourceId.of(`mail-mcp-${stage}-smoke-user-password`),
      // パスワードをハンドラのログに出さない
      logging: cr.Logging.withDataHidden(),
    };
    const smokePassword = new cr.AwsCustomResource(this, 'SmokeUserPassword', {
      onCreate: setSmokePassword,
      onUpdate: setSmokePassword,
      policy: cognitoAdmin,
      installLatestAwsSdk: false,
    });
    smokePassword.node.addDependency(smokeUser);

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: `${domainPrefix}.auth.${REGION}.amazoncognito.com` });
    new CfnOutput(this, 'SmokeUserSecretArn', { value: this.smokeUserSecret.secretArn });

    // ---- EventBridge Scheduler（ADR-0003: 予約送信の一回限りスケジュール）----
    this.scheduleGroupName = `mail-mcp-${stage}`;
    new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', { name: this.scheduleGroupName });
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'EventBridge Scheduler target role for scheduled-send',
    });
    this.scheduledSendFunctionArn = this.formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: `mail-mcp-${stage}-scheduled-send`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    // ---- AgentCore Runtime（ADR-0001 / ADR-0005）----
    this.image = new ContainerImageBuild(this, 'McpImage', {
      directory: '.',
      file: 'docker/Dockerfile',
      platform: Platform.LINUX_ARM64,
      // .dockerignore（`*` + `!dist/mcp` + `!docker`）を Docker の意味論で解釈させる。
      // 既定の GLOB では `*` がドットファイルに掛からず .env / .git がアセットに入ってしまう
      ignoreMode: IgnoreMode.DOCKER,
    });
    this.runtime = new agentcore.Runtime(this, 'McpRuntime', {
      runtimeName: `mail_mcp_${stage}`,
      description: 'mcp-mail-manager MCP server',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromEcrRepository(this.image.repository, this.image.imageTag),
      protocolConfiguration: agentcore.ProtocolType.MCP,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork(),
      // JWT 検証はプラットフォームが行う（discovery URL = User Pool の openid-configuration、allowedClients = アプリクライアント）
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(this.userPool, [this.userPoolClient]),
      environmentVariables: {
        STAGE: stage,
        TABLE_NAME: this.table.tableName,
        BUCKET_NAME: this.bucket.bucketName,
        MAIL_SECRET_ARN: this.mailSecret.secretArn,
        SCHEDULE_GROUP: this.scheduleGroupName,
        SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
        SCHEDULED_SEND_FUNCTION_ARN: this.scheduledSendFunctionArn,
      },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: Duration.minutes(5) },
    });
    // 実行ロール（design.md 7 章）: DynamoDB R/W、S3 Get、Secrets Get、Scheduler はグループ限定、PassRole は起動ロール限定
    const mcpRole = this.runtime.role;
    this.table.grantReadWriteData(mcpRole);
    this.bucket.grantRead(mcpRole);
    this.mailSecret.grantRead(mcpRole);
    mcpRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [this.formatArn({ service: 'scheduler', resource: 'schedule', resourceName: `${this.scheduleGroupName}/*` })],
      }),
    );
    mcpRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.schedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );

    new CfnOutput(this, 'AgentRuntimeArn', { value: this.runtime.agentRuntimeArn });

    // ---- バッチ: 予約送信 Lambda + failed アラーム（T-031）、同期 Lambda + rate(15 minutes)（T-018）----
    new ScheduledSend(this, 'ScheduledSend', {
      stage,
      table: this.table,
      mailSecret: this.mailSecret,
      schedulerRole: this.schedulerRole,
      alarmEmail: this.node.tryGetContext('alarmEmail'),
    });
    new SyncJob(this, 'Sync', {
      stage,
      table: this.table,
      bucket: this.bucket,
      mailSecret: this.mailSecret,
      schedulerRole: this.schedulerRole,
    });

    // ---- façade: CloudFront + CloudFront Functions（ADR-0001 / ADR-0004、design.md 3.1b）----
    const cognitoIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${this.userPool.userPoolId}`;
    const placeholders: Record<string, string> = {
      __RUNTIME_ARN__: this.runtime.agentRuntimeArn,
      __COGNITO_ISSUER__: cognitoIssuer,
      __COGNITO_DOMAIN__: `https://${domainPrefix}.auth.${REGION}.amazoncognito.com`,
      __JWKS_URI__: `${cognitoIssuer}/.well-known/jwks.json`,
    };
    // synth 時にプレースホルダを置換する（トークンを含むので Fn::Join になる）。パスはリポジトリルート基準
    const functionCode = (file: string) => {
      let code = readFileSync(resolve('infra/functions', file), 'utf8');
      for (const [key, value] of Object.entries(placeholders)) code = code.split(key).join(value);
      return cloudfront.FunctionCode.fromInline(code);
    };
    // viewer-response 関数は使わない: CloudFront はオリジンのエラー応答（AgentCore の 401）で viewer-response を呼ばないため、
    // 401 の WWW-Authenticate 上書きは成立しない。代わりに viewer-request がトークン無し / 期限切れを判定して 401 を返す
    const viewerRequest = new cloudfront.Function(this, 'ViewerRequest', {
      code: functionCode('viewer-request.js'),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'OAuth well-known + auth pre-check + /mcp rewrite to AgentCore',
    });
    this.distribution = new cloudfront.Distribution(this, 'Facade', {
      comment: `mail-mcp ${stage} facade`,
      defaultBehavior: {
        origin: new HttpOrigin(`bedrock-agentcore.${REGION}.amazonaws.com`, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          readTimeout: Duration.seconds(30),
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: viewerRequest, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    new CfnOutput(this, 'McpUrl', { value: `https://${this.distribution.distributionDomainName}/mcp` });
  }
}
