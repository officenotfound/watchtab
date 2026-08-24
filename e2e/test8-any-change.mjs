// Alert mode "Any change", blank keywords: any DOM text mutation should trigger
// lastTriggerKind === 'any-change' on the next scan.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p id="target">original text</p></body></html>`);
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

  await popup.locator('.modeButton', { hasText: 'Any change' }).click();
  await popup.waitForTimeout(1500); // let first scan establish a snapshot hash

  let storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  let tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('before mutation, lastTriggerKind:', tabState?.monitorState?.lastTriggerKind, 'lastScanAt set:', !!tabState?.monitorState?.lastScanAt);
  const scannedOnce = !!tabState?.monitorState?.lastScanAt;

  await page.evaluate(() => { document.querySelector('#target').textContent = 'mutated text'; });
  await page.waitForTimeout(1500);

  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after mutation, lastTriggerKind:', tabState?.monitorState?.lastTriggerKind);
  const anyChangeTriggered = tabState?.monitorState?.lastTriggerKind === 'any-change';

  const pass = scannedOnce && anyChangeTriggered;
  if (!pass) {
    console.log('EXPECTED: scan established before mutation; lastTriggerKind="any-change" after mutation');
    console.log(`OBSERVED: scannedOnce=${scannedOnce}, lastTriggerKind=${tabState?.monitorState?.lastTriggerKind}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
