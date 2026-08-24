// Alert mode "Keyword lost": start matching, then remove the keyword from the page.
// Confirm lastTriggerKind === 'lost' and the refresh timer auto-stops (active:false),
// same behavior test1 proved for 'found'.
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
  headless: false, // kept false: Playwright's own 'headless: true' breaks MV3 extension loading here; '--headless=new' below forces true headless instead (no OS window) while extensions still work. // 'headless: true' breaks MV3 extension loading in this Chrome for Testing build (no service worker registers).
  // '--headless=new' forces Chrome's new headless mode instead, which does support extensions and opens no OS window.
  args: [
    '--headless=new',
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

  await popup.locator('.modeButton', { hasText: 'Keyword lost' }).click();
  await popup.waitForTimeout(1500); // let it register hasEverMatched=true

  let storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  let tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('before removal, hasEverMatched:', tabState?.monitorState?.hasEverMatched, 'currentlyMatching:', tabState?.monitorState?.currentlyMatching);
  const everMatched = tabState?.monitorState?.hasEverMatched === true;

  // Start refreshing so we can observe the auto-stop-on-trigger behavior.
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(500);

  // Now remove the keyword from the page.
  await page.evaluate(() => { document.querySelector('#target').textContent = 'nothing relevant here'; });
  await page.waitForTimeout(2000);

  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after removal, lastTriggerKind:', tabState?.monitorState?.lastTriggerKind, 'active:', tabState?.active);
  const lostTriggered = tabState?.monitorState?.lastTriggerKind === 'lost';
  const autoStopped = tabState?.active === false;

  const pass = everMatched && lostTriggered && autoStopped;
  if (!pass) {
    console.log('EXPECTED: hasEverMatched=true before removal; lastTriggerKind="lost" and active=false after removal');
    console.log(`OBSERVED: everMatched=${everMatched}, lastTriggerKind=${tabState?.monitorState?.lastTriggerKind}, active=${tabState?.active}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
