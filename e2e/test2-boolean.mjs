// Boolean expression matching: ##(A OR B) AND (C OR D)## with parens/AND/OR.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p id="target">in stock, add to cart</p></body></html>`);
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
  await keywordBox.fill('##(in stock OR available) AND (add to cart OR buy now)##');
  await popup.waitForTimeout(1500); // let the 1s poll pick it up and scan

  let storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  let tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after initial text, currentlyMatching:', tabState?.monitorState?.currentlyMatching);
  const matchedInitially = tabState?.monitorState?.currentlyMatching === true;

  // Drop "add to cart" from the page so the AND clause should fail.
  await page.evaluate(() => {
    document.querySelector('#target').textContent = 'in stock only';
  });
  await page.waitForTimeout(1500);

  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after mutation, currentlyMatching:', tabState?.monitorState?.currentlyMatching);
  const matchGoneAfterMutation = tabState?.monitorState?.currentlyMatching === false;

  const pass = matchedInitially && matchGoneAfterMutation;
  if (!pass) {
    console.log('EXPECTED: matched=true initially, then matched=false after mutation');
    console.log(`OBSERVED: matchedInitially=${matchedInitially}, matchGoneAfterMutation=${matchGoneAfterMutation}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
