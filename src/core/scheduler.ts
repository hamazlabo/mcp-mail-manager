import { CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient } from '@aws-sdk/client-scheduler';

/**
 * SendScheduler: EventBridge Scheduler の一回限りスケジュール（design.md 3.3 / REQ-040〜041, ADR-0003）。
 */
export interface SendScheduler {
  /** `at(<sendAt>)` の一回限りスケジュールを作る。ターゲットは scheduled-send Lambda、入力は `{ scheduleId }` */
  create(input: { scheduleName: string; scheduleId: string; sendAt: Date }): Promise<void>;
  /** スケジュールを削除する。既に無い場合も成功扱い */
  remove(scheduleName: string): Promise<void>;
}

export interface EventBridgeSendSchedulerOptions {
  /** スケジュールグループ `mail-mcp-<stage>` */
  groupName: string;
  /** scheduled-send Lambda の ARN */
  targetArn: string;
  /** Scheduler がターゲット起動に使うロール */
  roleArn: string;
  client?: SchedulerClient;
}

/** 一回限りスケジュール: `at(<UTC 秒切り捨て>)`、完了後に自動削除、再試行 3 回。 */
export class EventBridgeSendScheduler implements SendScheduler {
  private readonly client: SchedulerClient;
  private readonly groupName: string;
  private readonly targetArn: string;
  private readonly roleArn: string;

  constructor(options: EventBridgeSendSchedulerOptions) {
    this.client = options.client ?? new SchedulerClient({});
    this.groupName = options.groupName;
    this.targetArn = options.targetArn;
    this.roleArn = options.roleArn;
  }

  async create({ scheduleName, scheduleId, sendAt }: { scheduleName: string; scheduleId: string; sendAt: Date }): Promise<void> {
    await this.client.send(
      new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: this.groupName,
        ScheduleExpression: `at(${sendAt.toISOString().slice(0, 19)})`,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: this.targetArn,
          RoleArn: this.roleArn,
          Input: JSON.stringify({ scheduleId }),
          RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
        },
      }),
    );
  }

  async remove(scheduleName: string): Promise<void> {
    try {
      await this.client.send(new DeleteScheduleCommand({ Name: scheduleName, GroupName: this.groupName }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err;
    }
  }
}
