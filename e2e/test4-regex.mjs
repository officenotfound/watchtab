// Regex matching: $product\d+ matches, then a broken pattern surfaces monitorState.error
// without crashing (no pageerror/popupError).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p id="target">we have product42 in stock</p></body></html>`);
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

let pageErrors = [];
let popupErrors = [];

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  console.log('extension id:', extId);

  const page = await context.newPage();
  page.on('pageerror', (err) => { pageErrors.push(err.message); console.log('[page error]', err.message); });
  await page.goto(TEST_URL);
  await page.waitForTimeout(500);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => { popupErrors.push(err.message); console.log('[popup error]', err.message); });
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
  await keywordBox.fill('$product\\d+');
  await popup.waitForTimeout(1500);

  let storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  let tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after $product\\d+, currentlyMatching:', tabState?.monitorState?.currentlyMatching, 'error:', tabState?.monitorState?.error);
  const matchedInitially = tabState?.monitorState?.currentlyMatching === true && !tabState?.monitorState?.error;

  await keywordBox.fill('$(unclosed');
  await popup.waitForTimeout(1500);

  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after broken regex, error:', tabState?.monitorState?.error);
  const hasError = typeof tabState?.monitorState?.error === 'string' && tabState.monitorState.error.length > 0;

  // popup should also reflect the error state in its status text; give its own
  // 1s state poll a cycle to catch up.
  await popup.waitForTimeout(1200);
  const popupStatusText = await popup.locator('.status').last().innerText().catch(() => '');
  console.log('popup status text:', JSON.stringify(popupStatusText));
  const popupShowsError = popupStatusText.toLowerCase().includes('error');

  const noErrors = pageErrors.length === 0 && popupErrors.length === 0;

  const pass = matchedInitially && hasError && popupShowsError && noErrors;
  if (!pass) {
    console.log('EXPECTED: matchedInitially=true, hasError=true (broken regex), popupShowsError=true, no pageerror/popup crash events');
    console.log(`OBSERVED: matchedInitially=${matchedInitially}, hasError=${hasError}, popupShowsError=${popupShowsError}, pageErrors=${JSON.stringify(pageErrors)}, popupErrors=${JSON.stringify(popupErrors)}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
