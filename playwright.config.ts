import { defineConfig } from '@playwright/test';

const port = process.env.IMSTAGE_TEST_PORT || '4417';
const localURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/ui',
  outputDir: process.env.IMSTAGE_ARTIFACT_DIR ? `${process.env.IMSTAGE_ARTIFACT_DIR}/test-results` : '.local/test-results',
  fullyParallel: true, workers: 2, timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: process.env.IMSTAGE_BASE_URL || localURL, viewport: { width: 1440, height: 1000 },
    channel: process.env.IMSTAGE_BROWSER === 'chromium' ? undefined : 'chrome',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: process.env.IMSTAGE_BASE_URL ? undefined : {
    command: 'npm start',
    env: { IMSTAGE_WEB_PORT: port, IMSTAGE_APP_ORIGIN: localURL, IMSTAGE_DATA_DIR: `${process.env.IMSTAGE_ARTIFACT_DIR || '.local/ui-artifacts'}/accounts` },
    url: localURL, reuseExistingServer: !process.env.CI,
  },
});
