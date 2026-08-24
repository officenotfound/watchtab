// Expression templates: clicking a template chip appends its expression to
// the keywords textarea (appending, not clobbering existing text), and the
// resulting expression actually matches on the page.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test20');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p>Now $19.99, add to cart today</p></body></html>`);
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

  await popup.locator('.toggleRow', { hasText: 'Monitor page for changes' }).locator('input[type="checkbox"]').click();
  await popup.waitForTimeout(200);

  const keywordBox = popup.locator('#monitor-keywords');
  await keywordBox.fill('preexisting');
  await popup.waitForTimeout(200);

  await popup.locator('.chip', { hasText: 'Shopping actions' }).click();
  await popup.waitForTimeout(200);

  const valueAfterOneTemplate = await keywordBox.inputValue();
  console.log('keywords after clicking one template:', JSON.stringify(valueAfterOneTemplate));
  const appendedNotClobbered =
    valueAfterOneTemplate.includes('preexisting') && valueAfterOneTemplate.includes('add to cart');

  await popup.locator('.chip', { hasText: 'Price changes' }).click();
  await popup.waitForTimeout(1000);

  const valueAfterTwoTemplates = await keywordBox.inputValue();
  console.log('keywords after clicking two templates:', JSON.stringify(valueAfterTwoTemplates));

  const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  const tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('currentlyMatching after price-regex template added:', tabState?.monitorState?.currentlyMatching);
  const priceRegexMatched = tabState?.monitorState?.currentlyMatching === true;

  const pass = appendedNotClobbered && priceRegexMatched;
  if (!pass) {
    console.log('EXPECTED: template text appended (not replacing existing keywords), and the $ price-regex template matches "$19.99" on the page');
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
