// "Wait for load" delay: set to ~3000ms, reload the page, confirm no scan has landed
// at ~1s post-reload, and a scan has landed by ~4s post-reload.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p id="target">the widget is here</p></body></html>`);
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
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

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

  const monitorToggle = popup
    .locator('.toggleRow', { hasText: 'Monitor page for changes' })
    .locator('input[type="checkbox"]');
  await monitorToggle.click();
  await popup.waitForTimeout(300);

  const keywordBox = popup.locator('#monitor-keywords');
  await keywordBox.waitFor({ state: 'visible', timeout: 5000 });
  await keywordBox.fill('widget');
  await popup.waitForTimeout(200);

  const waitInput = popup.locator('#monitor-wait');
  await waitInput.fill('3000');
  await popup.waitForTimeout(300);

  const dump = async () => {
    const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
    return Object.values(storageDump).find((v) => v && v.monitor);
  };

  // monitorState.lastScanAt persists in storage across a page reload (it isn't
  // reset by navigation), so "no scan yet" must be judged relative to the
  // pre-reload value, not against null.
  const preReloadState = await dump();
  const preReloadScanAt = preReloadState?.monitorState?.lastScanAt;
  console.log('lastScanAt just before reload:', preReloadScanAt);

  await page.reload();
  const reloadedAt = Date.now();
  await page.bringToFront();

  await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - reloadedAt))));
  let tabState = await dump();
  const elapsed1 = Date.now() - reloadedAt;
  console.log(`at ~${elapsed1}ms post-reload, lastScanAt:`, tabState?.monitorState?.lastScanAt);
  const noScanYet = tabState?.monitorState?.lastScanAt === preReloadScanAt;

  await new Promise((r) => setTimeout(r, Math.max(0, 4000 - (Date.now() - reloadedAt))));
  tabState = await dump();
  const elapsed2 = Date.now() - reloadedAt;
  console.log(`at ~${elapsed2}ms post-reload, lastScanAt:`, tabState?.monitorState?.lastScanAt);
  const scannedByNow = !!tabState?.monitorState?.lastScanAt && tabState.monitorState.lastScanAt !== preReloadScanAt;

  const pass = noScanYet && scannedByNow;
  if (!pass) {
    console.log('EXPECTED: lastScanAt unchanged from pre-reload value at ~1s post-reload (waitForLoadMs=3000 not yet elapsed); a fresh lastScanAt by ~4s post-reload');
    console.log(`OBSERVED: preReloadScanAt=${preReloadScanAt}, noScanYet=${noScanYet}, scannedByNow=${scannedByNow}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
