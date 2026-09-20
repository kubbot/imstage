import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  outputDir: process.env.IMSTAGE_ARTIFACT_DIR ? `${process.env.IMSTAGE_ARTIFACT_DIR}/test-results` : '.local/test-results',
  fullyParallel: true, workers: 2, timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4417', viewport: { width: 1440, height: 1000 },
    channel: process.env.IMSTAGE_BROWSER === 'chromium' ? undefined : 'chrome',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:4417', reuseExistingServer: !process.env.CI },
});
