import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, SchedulerClient } from '@aws-sdk/client-scheduler';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBridgeSendScheduler } from '../../../src/core/scheduler';
import type { ScheduledItem } from '../../../src/core/types';
import { registerCancelScheduledMessage } from '../../../src/mcp/tools/cancel_scheduled_message';
import { registerListScheduledMessages } from '../../../src/mcp/tools/list_scheduled_messages';
import { registerScheduleMessage } from '../../../src/mcp/tools/schedule_message';
import { call, config, connect, json, makeCtx, NOW, text } from './helpers';

const ddbMock = mockClient(DynamoDBDocumentClient);
const schedulerMock = mockClient(SchedulerClient);

beforeEach(() => {
  ddbMock.reset();
  schedulerMock.reset();
});

const validInput = { sendAt: '2026-10-01T18:00:00+09:00', to: ['bob@example.net'], subject: 'hello', body: 'hi' };

/** putScheduled / deleteScheduled / listScheduled を記録する store と、scheduler の呼出記録 */
function setup(opts: { createFails?: boolean; items?: ScheduledItem[] } = {}) {
  const put: ScheduledItem[] = [];
  const deleted: string[] = [];
  const created: unknown[] = [];
  const removed: string[] = [];
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const store = {
    tableName: 'MailTable-test',
    ddb,
    putScheduled: async (item: ScheduledItem) => {
      put.push(item);
    },
    deleteScheduled: async (id: string) => {
      deleted.push(id);
    },
    listScheduled: async () => opts.items ?? [],
  };
  const scheduler = {
    create: async (input: unknown) => {
      if (opts.createFails) throw new Error('CreateSchedule failed: ValidationException');
      created.push(input);
    },
    remove: async (name: string) => {
      removed.push(name);
    },
  };
  const ctx = makeCtx({ store, scheduler });
  return { ctx, put, deleted, created, removed };
}

const registerAll = (ctx: ReturnType<typeof makeCtx>) => (s: Parameters<typeof registerScheduleMessage>[0]) => {
  registerScheduleMessage(s, ctx);
  registerListScheduledMessages(s, ctx);
  registerCancelScheduledMessage(s, ctx);
};

describe('schedule_message (REQ-040)', () => {
  it('rejects a past or more-than-one-year-ahead sendAt without writing anything', async () => {
    const { ctx, put, created } = setup();
    const client = await connect(registerAll(ctx));
    for (const sendAt of ['2026-09-18T00:00:00Z', '2027-09-20T00:00:00Z', 'tomorrow']) {
      const result = await call(client, 'schedule_message', { ...validInput, sendAt });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('sendAt');
    }
    expect(put).toEqual([]);
    expect(created).toEqual([]);
  });

  it('rejects an invalid recipient (same validation as send)', async () => {
    const { ctx, put, created } = setup();
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'schedule_message', { ...validInput, to: ['not-an-address'] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid recipient');
    expect(put).toEqual([]);
    expect(created).toEqual([]);
  });

  it('stores a pending record, then registers a one-time schedule', async () => {
    const { ctx, put, created } = setup();
    const client = await connect(registerAll(ctx));
    const result = json<{ scheduleId: string; sendAt: string }>(await call(client, 'schedule_message', validInput));
    expect(result.sendAt).toBe('2026-10-01T09:00:00.000Z');
    expect(put).toHaveLength(1);
    expect(put[0]).toMatchObject({
      scheduleId: result.scheduleId,
      status: 'pending',
      attempts: 0,
      sendAt: '2026-10-01T09:00:00.000Z',
      to: ['bob@example.net'],
      cc: [],
      bcc: [],
      subject: 'hello',
      body: 'hi',
      scheduleName: `mail-mcp-${result.scheduleId}`,
      createdAt: NOW.toISOString(),
    });
    expect(put[0].messageId).toMatch(new RegExp(`^<[0-9a-f-]{36}@${config.domain}>$`));
    expect(created).toEqual([
      { scheduleName: `mail-mcp-${result.scheduleId}`, scheduleId: result.scheduleId, sendAt: new Date('2026-10-01T09:00:00Z') },
    ]);
  });

  it('removes the pending record when the schedule cannot be created', async () => {
    const { ctx, put, deleted } = setup({ createFails: true });
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'schedule_message', validInput);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('CreateSchedule failed');
    expect(deleted).toEqual([put[0].scheduleId]);
  });
});

describe('list_scheduled_messages / cancel_scheduled_message (REQ-041)', () => {
  const item: ScheduledItem = {
    scheduleId: 'abc',
    status: 'failed',
    sendAt: '2026-10-01T09:00:00.000Z',
    to: ['bob@example.net'],
    cc: [],
    bcc: [],
    subject: 'hello',
    body: 'SECRET BODY',
    messageId: '<x@example.net>',
    scheduleName: 'mail-mcp-abc',
    attempts: 3,
    error: 'SMTP 550',
    createdAt: '2026-09-19T00:00:00.000Z',
  };

  it('lists id / status / sendAt / to / subject / error without the body', async () => {
    const { ctx } = setup({ items: [item] });
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'list_scheduled_messages', { status: 'failed' });
    expect(json(result)).toEqual([
      { scheduleId: 'abc', status: 'failed', sendAt: '2026-10-01T09:00:00.000Z', to: ['bob@example.net'], subject: 'hello', error: 'SMTP 550' },
    ]);
    expect(text(result)).not.toContain('SECRET BODY');
  });

  it('refuses to cancel a schedule that is not pending', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'no', $metadata: {} }));
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'SCHED#abc', SK: 'META', status: 'sent' } });
    const { ctx, removed } = setup();
    const client = await connect(registerAll(ctx));
    const result = await call(client, 'cancel_scheduled_message', { scheduleId: 'abc' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('sent');
    expect(removed).toEqual([]);
  });

  it('cancels a pending schedule and deletes it from the scheduler', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const { ctx, removed } = setup();
    const client = await connect(registerAll(ctx));
    expect(json(await call(client, 'cancel_scheduled_message', { scheduleId: 'abc' }))).toEqual({ scheduleId: 'abc', status: 'cancelled' });
    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ConditionExpression).toBe('#status = :pending');
    expect(update.Key).toEqual({ PK: 'SCHED#abc', SK: 'META' });
    expect(removed).toEqual(['mail-mcp-abc']);
  });
});

describe('EventBridgeSendScheduler', () => {
  const scheduler = new EventBridgeSendScheduler({
    groupName: 'mail-mcp-dev',
    targetArn: 'arn:aws:lambda:ap-northeast-1:123:function:send',
    roleArn: 'arn:aws:iam::123:role/scheduler',
    client: new SchedulerClient({}),
  });

  it('creates a one-time at() schedule in UTC that deletes itself after completion', async () => {
    schedulerMock.on(CreateScheduleCommand).resolves({});
    await scheduler.create({ scheduleName: 'mail-mcp-abc', scheduleId: 'abc', sendAt: new Date('2026-10-01T09:00:00.500Z') });
    const input = schedulerMock.commandCalls(CreateScheduleCommand)[0].args[0].input;
    expect(input).toMatchObject({
      Name: 'mail-mcp-abc',
      GroupName: 'mail-mcp-dev',
      ScheduleExpression: 'at(2026-10-01T09:00:00)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: 'arn:aws:lambda:ap-northeast-1:123:function:send',
        RoleArn: 'arn:aws:iam::123:role/scheduler',
        Input: JSON.stringify({ scheduleId: 'abc' }),
        RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 },
      },
    });
  });

  it('remove deletes the schedule and ignores a missing one', async () => {
    schedulerMock.on(DeleteScheduleCommand).rejectsOnce(new ResourceNotFoundException({ message: 'gone', Message: 'gone', $metadata: {} }));
    await expect(scheduler.remove('mail-mcp-abc')).resolves.toBeUndefined();
    schedulerMock.on(DeleteScheduleCommand).resolves({});
    await scheduler.remove('mail-mcp-abc');
    expect(schedulerMock.commandCalls(DeleteScheduleCommand)[1].args[0].input).toEqual({ Name: 'mail-mcp-abc', GroupName: 'mail-mcp-dev' });
  });
});
