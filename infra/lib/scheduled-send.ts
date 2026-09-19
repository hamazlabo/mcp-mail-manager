/** 予約送信 Lambda（design.md 3.3）、failed アラーム + SNS。T-031 */
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import type { Stage } from './mail-mcp-stack';

export interface ScheduledSendProps {
  stage: Stage;
  table: dynamodb.ITable;
  mailSecret: secretsmanager.ISecret;
  /** Scheduler がこの Lambda を起動するロール（T-026 で作成） */
  schedulerRole: iam.IRole;
  /** アラーム通知先。未指定なら SNS トピックだけ作る */
  alarmEmail?: string;
}

export class ScheduledSend extends Construct {
  readonly fn: NodejsFunction;
  readonly topic: Topic;
  readonly alarm: Alarm;

  constructor(scope: Construct, id: string, props: ScheduledSendProps) {
    super(scope, id);
    const { stage, table, mailSecret, schedulerRole, alarmEmail } = props;

    this.fn = new NodejsFunction(this, 'Fn', {
      // MCP サーバは関数名の規約で ARN を組み立てる（infra: SCHEDULED_SEND_FUNCTION_ARN）
      functionName: `mail-mcp-${stage}-scheduled-send`,
      entry: 'src/scheduled-send/handler.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      // design.md 3.3: `sending` の鮮度判定（5 分）を超えないようにする
      timeout: Duration.minutes(5),
      environment: {
        STAGE: stage,
        TABLE_NAME: table.tableName,
        MAIL_SECRET_ARN: mailSecret.secretArn,
      },
      bundling: { format: OutputFormat.CJS, target: 'node22' },
      logGroup: new LogGroup(this, 'Logs', {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    // 最小権限: Scheduled アイテム（PK = SCHED#...）のみ R/W。S3 / Scheduler は持たない（NFR-004）
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SCHED#*'] } },
      }),
    );
    mailSecret.grantRead(this.fn);
    this.fn.grantInvoke(schedulerRole);

    // NFR-008: failed 遷移のメトリクス（EMF）にアラーム
    this.topic = new Topic(this, 'AlarmTopic', { topicName: `mail-mcp-${stage}-alarms` });
    if (alarmEmail) this.topic.addSubscription(new EmailSubscription(alarmEmail));
    this.alarm = new Alarm(this, 'FailedAlarm', {
      alarmName: `mail-mcp-${stage}-scheduled-send-failed`,
      metric: new Metric({
        namespace: 'MailMcp',
        metricName: 'ScheduledSendFailed',
        dimensionsMap: { Stage: stage },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    this.alarm.addAlarmAction(new SnsAction(this.topic));
  }
}
