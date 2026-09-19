/**
 * SendScheduler: EventBridge Scheduler の一回限りスケジュール（design.md 3.3 / REQ-040〜041, ADR-0003）。
 */
export interface SendScheduler {
  /** `at(<sendAt>)` の一回限りスケジュールを作る。ターゲットは scheduled-send Lambda、入力は `{ scheduleId }` */
  create(input: { scheduleName: string; scheduleId: string; sendAt: Date }): Promise<void>;
  /** スケジュールを削除する。既に無い場合も成功扱い */
  remove(scheduleName: string): Promise<void>;
}
