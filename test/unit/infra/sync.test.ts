import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

/** T-018: 同期 Lambda と EventBridge Scheduler の rate(15 minutes) */
let template: Template;

beforeAll(() => {
  const app = new App({ context: { stage: 'dev' } });
  template = Template.fromStack(new MailMcpStack(app, resolveStage(app)));
}, 60_000);

function policyStatements(roleLogicalId: string): any[] {
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: roleLogicalId }]) },
  });
  return Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

function actionsOf(statements: any[]): string[] {
  return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

describe('sync Lambda (T-018)', () => {
  it('defines the sync function on Node.js 22 with 512 MB and a 15 minute timeout, outside a VPC', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'mail-mcp-dev-sync',
      Runtime: 'nodejs22.x',
      MemorySize: 512,
      Timeout: 900,
      VpcConfig: Match.absent(),
      Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), BUCKET_NAME: Match.anyValue(), MAIL_SECRET_ARN: Match.anyValue() }) },
    });
  });

  it('schedules the sync function every 15 minutes with EventBridge Scheduler', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(15 minutes)',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: Match.objectLike({ Arn: Match.objectLike({ 'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('Sync')]) }) }),
    });
  });

  it('gives the sync role S3 put/delete and DynamoDB access but no Scheduler permissions', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'mail-mcp-dev-sync' } }))[0] as any;
    const roleId = fn.Properties.Role['Fn::GetAtt'][0];
    const actions = actionsOf(policyStatements(roleId));
    expect(actions).toEqual(expect.arrayContaining(['s3:PutObject', 's3:DeleteObject*', 'dynamodb:PutItem', 'secretsmanager:GetSecretValue']));
    expect(actions.some((a) => a.startsWith('scheduler:'))).toBe(false);
  });
});
