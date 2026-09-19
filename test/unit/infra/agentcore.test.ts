import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

let template: Template;

/** 論理 ID が pattern に一致するロールに紐づく IAM ポリシーの Statement を集める */
function statementsOfRole(pattern: RegExp): Record<string, unknown>[] {
  const roleIds = Object.keys(template.findResources('AWS::IAM::Role')).filter((id) => pattern.test(id));
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
    (p.Properties.Roles as { Ref: string }[]).some((r) => roleIds.includes(r.Ref)),
  );
  return policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
}
const actionsOf = (st: Record<string, unknown>): string[] => (Array.isArray(st.Action) ? st.Action : [st.Action]) as string[];

describe('AgentCore Runtime (MCP server)', () => {
  beforeAll(() => {
    const app = new App({ context: { stage: 'dev' } });
    template = Template.fromStack(new MailMcpStack(app, resolveStage(app)));
  }, 60_000);

  it('runs the MCP protocol on a public network with a 5 minute idle timeout', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeName: 'mail_mcp_dev',
      ProtocolConfiguration: 'MCP',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      LifecycleConfiguration: { IdleRuntimeSessionTimeout: 300 },
      EnvironmentVariables: Match.objectLike({
        STAGE: 'dev',
        TABLE_NAME: Match.anyValue(),
        BUCKET_NAME: Match.anyValue(),
        MAIL_SECRET_ARN: Match.anyValue(),
        SCHEDULE_GROUP: 'mail-mcp-dev',
        SCHEDULER_ROLE_ARN: Match.anyValue(),
        SCHEDULED_SEND_FUNCTION_ARN: Match.anyValue(),
      }),
    });
  });

  it('validates JWTs against the Cognito user pool and only the app client', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: Match.objectLike({
            'Fn::Join': ['', Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('^UserPool') })])],
          }),
          AllowedClients: [{ Ref: Match.stringLikeRegexp('AppClient') }],
        },
      },
    });
  });

  it('pulls the image built at deploy time by CodeBuild on ARM', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({ Type: 'ARM_CONTAINER' }),
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: Match.anyValue() } },
    });
  });

  it('gives the execution role least privilege: no s3:PutObject, Scheduler limited to the group, PassRole limited to the scheduler role', () => {
    const statements = statementsOfRole(/McpRuntimeExecutionRole/);
    expect(statements.length).toBeGreaterThan(0);
    const allActions = statements.flatMap(actionsOf);
    expect(allActions).not.toContain('s3:PutObject');
    expect(allActions.some((a) => /^s3:GetObject\*?$/.test(a))).toBe(true);
    expect(allActions).toContain('dynamodb:PutItem');
    expect(allActions).toContain('secretsmanager:GetSecretValue');

    const scheduler = statements.find((st) => actionsOf(st).includes('scheduler:CreateSchedule'));
    expect(JSON.stringify(scheduler?.Resource)).toContain('schedule/mail-mcp-dev/*');

    const passRole = statements.find((st) => actionsOf(st).includes('iam:PassRole'));
    expect(JSON.stringify(passRole?.Resource)).toMatch(/\{"Fn::GetAtt":\["SchedulerRole[A-Za-z0-9]*","Arn"\]\}/);
  });

  it('creates the schedule group and the scheduler target role, and exports AgentRuntimeArn', () => {
    template.hasResourceProperties('AWS::Scheduler::ScheduleGroup', { Name: 'mail-mcp-dev' });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } })],
      },
    });
    template.hasOutput('AgentRuntimeArn', {});
  });
});
