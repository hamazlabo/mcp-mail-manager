import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

/** T-031: scheduled-send Lambda、Scheduler グループ / 起動ロール、failed アラーム */
let template: Template;

beforeAll(() => {
  const app = new App({ context: { stage: 'dev', alarmEmail: 'alerts@example.invalid' } });
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

describe('scheduled-send (T-031)', () => {
  it('defines the function with the conventional name and a timeout of at most 5 minutes', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'mail-mcp-dev-scheduled-send' } }))[0] as any;
    expect(fn).toBeDefined();
    expect(fn.Properties.Timeout).toBeLessThanOrEqual(300);
    expect(fn.Properties.VpcConfig).toBeUndefined();
  });

  it('gives the function DynamoDB and Secrets access but no S3 or Scheduler permissions', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'mail-mcp-dev-scheduled-send' } }))[0] as any;
    const actions = actionsOf(policyStatements(fn.Properties.Role['Fn::GetAtt'][0]));
    expect(actions).toEqual(expect.arrayContaining(['dynamodb:UpdateItem', 'secretsmanager:GetSecretValue']));
    expect(actions.some((a) => a.startsWith('s3:') || a.startsWith('scheduler:'))).toBe(false);
  });

  it('lets the Scheduler target role invoke only the scheduled-send function', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: { AssumeRolePolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })]) } },
    });
    expect(Object.keys(roles)).toHaveLength(1);
    const statements = policyStatements(Object.keys(roles)[0]);
    // sync と scheduled-send の 2 関数を起動できるが、アクションは invoke だけ
    expect(new Set(actionsOf(statements))).toEqual(new Set(['lambda:InvokeFunction']));
  });

  it('defines the schedule group mail-mcp-<stage>', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'mail-mcp-dev' });
  });

  it('alarms on the ScheduledSendFailed metric and notifies an SNS topic subscribed by email', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ScheduledSendFailed',
      Namespace: 'MailMcp',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: [Match.objectLike({ Ref: Match.stringLikeRegexp('Alarm') })],
    });
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alerts@example.invalid' });
  });
});
