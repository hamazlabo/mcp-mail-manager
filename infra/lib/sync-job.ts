/** 同期 Lambda（design.md 3.2）と EventBridge Scheduler の rate(15 minutes)。T-018 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { Stage } from './mail-mcp-stack';

export interface SyncJobProps {
  stage: Stage;
  table: dynamodb.ITable;
  bucket: s3.IBucket;
  mailSecret: secretsmanager.ISecret;
  /** Scheduler がターゲットを起動するロール（scheduled-send と共用） */
  schedulerRole: iam.IRole;
}

export class SyncJob extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: SyncJobProps) {
    super(scope, id);
    const { stage, table, bucket, mailSecret, schedulerRole } = props;

    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: `mail-mcp-${stage}-sync`,
      entry: 'src/sync/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(15),
      environment: {
        STAGE: stage,
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        MAIL_SECRET_ARN: mailSecret.secretArn,
      },
      bundling: { format: OutputFormat.CJS, target: 'node22' },
      logGroup: new LogGroup(this, 'Logs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // 最小権限: DynamoDB R/W、S3 Put/Delete、Secrets 読取。Scheduler 権限は持たない（NFR-004）
    table.grantReadWriteData(this.fn);
    bucket.grantPut(this.fn);
    bucket.grantDelete(this.fn);
    mailSecret.grantRead(this.fn);

    // LambdaInvoke が schedulerRole に invoke 権限を付ける
    new Schedule(this, 'Schedule', {
      scheduleName: `mail-mcp-${stage}-sync`,
      schedule: ScheduleExpression.rate(Duration.minutes(15)),
      target: new LambdaInvoke(this.fn, { role: schedulerRole, retryAttempts: 0 }),
      description: 'IMAP → S3 / DynamoDB の差分同期（REQ-001）',
    });
  }
}
