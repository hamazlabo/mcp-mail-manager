import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { MailMcpStack, resolveStage } from '../../../infra/lib/mail-mcp-stack';

let template: Template;

describe('CloudFront façade', () => {
  beforeAll(() => {
    const app = new App({ context: { stage: 'dev' } });
    template = Template.fromStack(new MailMcpStack(app, resolveStage(app)));
  }, 60_000);

  it('forwards every method to the AgentCore endpoint without caching, keeping viewer headers except Host', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: [
          Match.objectLike({
            DomainName: 'bedrock-agentcore.ap-northeast-1.amazonaws.com',
            CustomOriginConfig: Match.objectLike({ OriginProtocolPolicy: 'https-only', OriginReadTimeout: 30 }),
          }),
        ],
        DefaultCacheBehavior: Match.objectLike({
          AllowedMethods: Match.arrayWith(['GET', 'POST']), // arrayWith は順序を保つ
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
          OriginRequestPolicyId: 'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        PriceClass: 'PriceClass_200',
      }),
    });
  });

  it('associates the viewer-request and viewer-response functions', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          // viewer-response はオリジンのエラー応答（401 等）で呼ばれないため使わない。認証の事前判定も viewer-request で行う
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
    const functions = Object.values(template.findResources('AWS::CloudFront::Function'));
    expect(functions).toHaveLength(1);
    for (const f of functions) expect(f.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    // viewer-request にはプレースホルダが置換された Runtime ARN（GetAtt）と Cognito の値が埋め込まれる
    const codes = functions.map((f) => JSON.stringify(f.Properties.FunctionCode));
    expect(codes.some((c) => c.includes('oauth-authorization-server') && c.includes('McpRuntime') && !c.includes('__RUNTIME_ARN__'))).toBe(true);
    expect(codes.some((c) => c.includes('www-authenticate'))).toBe(true);
  });

  it('exports McpUrl = https://<distribution>/mcp', () => {
    template.hasOutput('McpUrl', {
      Value: { 'Fn::Join': ['', Match.arrayWith(['https://', '/mcp'])] },
    });
  });
});
