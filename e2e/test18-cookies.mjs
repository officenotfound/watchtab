// Cookie automation: a 'before-refresh' rule should set a cookie just before
// the actual scheduled tabs.reload() fires, so document.cookie on the
// reloaded page contains it.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test18');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const TEST_URL = `http://127.0.0.1:${port}/`;

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--headless=new',
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  sw.on('console', (msg) => console.log('[sw]', msg.type(), msg.text()));

  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('[page error]', err.message));
  await page.goto(TEST_URL);
  await page.waitForTimeout(500);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  // Fastest fixed preset (5s) so the test doesn't have to wait on the 30s default.
  await popup.getByRole('button', { name: '5s', exact: true }).click();
  await popup.waitForTimeout(200);

  await popup.locator('.tabRow .modeButton', { hasText: 'Automation' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.chip', { hasText: 'Add cookie rule' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('input[placeholder="cookie name"]').fill('watchtab_test');
  await popup.locator('input[placeholder="value"]').fill('hello123');
  await popup.waitForTimeout(300);
  // Defaults: action=set, timing=before-refresh — exactly what we want to test.

  const cookieBeforeStart = await page.evaluate(() => document.cookie);
  console.log('cookie before start:', JSON.stringify(cookieBeforeStart));

  await popup.getByText('Start refreshing').click();
  // Wait past the 5s scheduled refresh, with margin for the reload + load.
  await popup.waitForTimeout(8000);

  const cookieAfterRefresh = await page.evaluate(() => document.cookie);
  console.log('cookie after scheduled refresh:', JSON.stringify(cookieAfterRefresh));

  const pass = !cookieBeforeStart.includes('watchtab_test') && cookieAfterRefresh.includes('watchtab_test=hello123');
  if (!pass) {
    console.log('EXPECTED: no watchtab_test cookie before start; watchtab_test=hello123 present after the scheduled refresh');
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
