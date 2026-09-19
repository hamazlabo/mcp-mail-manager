/**
 * CloudWatch Embedded Metric Format（NFR-008）。1 行の JSON を stdout に出すと Lambda のログからメトリクスが生成される。
 */
export function emitScheduledSendFailed(stage: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'MailMcp', Dimensions: [['Stage']], Metrics: [{ Name: 'ScheduledSendFailed', Unit: 'Count' }] }],
      },
      Stage: stage,
      ScheduledSendFailed: 1,
    }),
  );
}
