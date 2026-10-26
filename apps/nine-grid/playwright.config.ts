import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.NINE_GRID_TEST_BASE_URL || 'http://127.0.0.1:5196/nine-grid/';
const target = new URL(baseURL);
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/nine-grid/') {
  throw new Error('九格验收仅允许隔离的本地 HTTP 服务，路径必须为 /nine-grid/，禁止指向生产网站。');
}
const workDirectory = fileURLToPath(new URL('../../work/', import.meta.url));
const browserTemp = fileURLToPath(new URL('../../work/browser-temp/', import.meta.url));
mkdirSync(browserTemp, { recursive: true });
process.env.TEMP = browserTemp;
process.env.TMP = browserTemp;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: `${workDirectory}/nine-grid-playwright-results`,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${workDirectory}/nine-grid-playwright-report` }],
    ['json', { outputFile: `${workDirectory}/nine-grid-playwright-results.json` }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    channel: 'chrome',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Start the isolated parent website separately. Never substitute the standalone Vite app.
});
