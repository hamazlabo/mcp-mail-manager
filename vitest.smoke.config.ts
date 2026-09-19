import { defineConfig } from 'vitest/config';

// デプロイ済み環境に対する正常性テスト。CDK_OUTPUTS_FILE と STAGE から接続先を解決する。
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    passWithNoTests: true,
  },
});
