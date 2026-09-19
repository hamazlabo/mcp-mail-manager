/**
 * 構造化ログ（NFR-008, REQ-052）。
 * 本文・認証情報・トークンを出力しないよう、キー名でマスクする。
 */
const REDACT_KEYS = new Set(['password', 'authorization', 'body', 'text', 'raw']);

type Level = 'info' | 'warn' | 'error';

/** マスク対象キーの値を "[redacted]" に置換する（ネスト・配列も再帰）。Error は name / message のみ残す */
export function redact(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  const line = { level, event, time: new Date().toISOString(), ...(redact(fields ?? {}) as Record<string, unknown>) };
  console.log(JSON.stringify(line));
}

export const logger = {
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
