import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelScheduled, claimSending, markFailed, markSent, validateSendAt } from '../../../src/core/scheduled';
import type { ScheduledItem } from '../../../src/core/types';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ctx = { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName: 'MailTable-test' };
const now = new Date('2026-09-19T12:00:00.000Z');
const NINETY_DAYS = 90 * 86400;

const item: ScheduledItem = {
  scheduleId: 'sch-1',
  status: 'pending',
  sendAt: '2026-10-01T09:00:00.000Z',
  to: ['bob@example.net'],
  cc: [],
  bcc: [],
  subject: 'later',
  body: 'hi',
  messageId: '<uuid@example.net>',
  scheduleName: 'mail-mcp-sch-1',
  attempts: 0,
  createdAt: '2026-09-19T00:00:00.000Z',
};

function conditionFailed() {
  return new ConditionalCheckFailedException({ $metadata: {}, message: 'The conditional request failed' });
}

beforeEach(() => ddbMock.reset());

describe('validateSendAt', () => {
  it('accepts a timezone-qualified ISO 8601 time in the future within one year', () => {
    expect(validateSendAt('2026-10-01T18:00:00+09:00', now).toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(validateSendAt('2027-09-19T12:00:00Z', now).toISOString()).toBe('2027-09-19T12:00:00.000Z');
  });

  it('rejects past times, times more than one year ahead, and values without a timezone', () => {
    expect(() => validateSendAt('2026-09-19T11:59:59Z', now)).toThrow(/past/);
    expect(() => validateSendAt('2027-09-19T12:00:01Z', now)).toThrow(/year/);
    expect(() => validateSendAt('2026-10-01T09:00:00', now)).toThrow(/timezone|ISO 8601/);
    expect(() => validateSendAt('next tuesday', now)).toThrow(/ISO 8601/);
  });
});

describe('claimSending', () => {
  it('moves pending → sending with a status condition and increments attempts', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...item, PK: 'SCHED#sch-1', SK: 'META', status: 'sending', attempts: 1 } });

    const result = await claimSending(ctx, 'sch-1', now);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.TableName).toBe('MailTable-test');
    expect(input.Key).toEqual({ PK: 'SCHED#sch-1', SK: 'META' });
    expect(input.ConditionExpression).toBe('#status = :pending');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':pending': 'pending', ':sending': 'sending', ':now': now.toISOString() });
    expect(input.UpdateExpression).toMatch(/#attempts = #attempts \+ :one/);
    expect(input.ReturnValues).toBe('ALL_NEW');
    expect(result).toEqual({ claimed: true, item: { ...item, status: 'sending', attempts: 1 } });
  });

  it('returns the current status (and item) when the condition fails, or missing when there is no item', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand).resolvesOnce({ Item: { ...item, PK: 'SCHED#sch-1', SK: 'META', status: 'sending', attempts: 1 } }).resolvesOnce({});

    expect(await claimSending(ctx, 'sch-1', now)).toEqual({
      claimed: false,
      status: 'sending',
      item: { ...item, status: 'sending', attempts: 1 },
    });
    expect(await claimSending(ctx, 'sch-1', now)).toEqual({ claimed: false, status: 'missing', item: undefined });
  });

  it('rethrows errors other than a failed condition', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));
    await expect(claimSending(ctx, 'sch-1', now)).rejects.toThrow('boom');
  });
});

describe('markSent / markFailed', () => {
  it('markSent sets status=sent and a ttl 90 days after now', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await markSent(ctx, 'sch-1', now);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'SCHED#sch-1', SK: 'META' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': 'sent',
      ':ttl': Math.floor(now.getTime() / 1000) + NINETY_DAYS,
      ':now': now.toISOString(),
    });
    expect(input.UpdateExpression).toMatch(/#status = :status/);
    expect(input.UpdateExpression).toMatch(/#ttl = :ttl/);
  });

  it('markFailed sets status=failed with the error and a ttl', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await markFailed(ctx, 'sch-1', 'unknown-delivery', now);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': 'failed',
      ':error': 'unknown-delivery',
      ':ttl': Math.floor(now.getTime() / 1000) + NINETY_DAYS,
    });
    expect(input.UpdateExpression).toMatch(/#error = :error/);
  });
});

describe('cancelScheduled', () => {
  it('moves pending → cancelled with a status condition and a ttl', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    expect(await cancelScheduled(ctx, 'sch-1', now)).toEqual({ cancelled: true });

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe('#status = :pending');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':pending': 'pending',
      ':status': 'cancelled',
      ':ttl': Math.floor(now.getTime() / 1000) + NINETY_DAYS,
    });
  });

  it('reports the current status instead of throwing when the schedule is not pending', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    ddbMock.on(GetCommand).resolvesOnce({ Item: { ...item, status: 'sent' } }).resolvesOnce({});

    expect(await cancelScheduled(ctx, 'sch-1', now)).toEqual({ cancelled: false, status: 'sent' });
    expect(await cancelScheduled(ctx, 'sch-1', now)).toEqual({ cancelled: false, status: 'missing' });
  });
});
