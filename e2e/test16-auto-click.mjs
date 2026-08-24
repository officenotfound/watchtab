// Auto-click keyword link: when a keyword match is found and it's inside an
// <a>, watchtab clicks it (target=_blank per autoClickOpenNewTab) and
// navigates the page.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test16');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url === '/target') {
    res.end(`<!doctype html><html><body><h1>Landed</h1></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
    <h1>Test Page</h1>
    <a id="link" href="/target">the widget is in stock now</a>
  </body></html>`);
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
  page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));
  await page.goto(TEST_URL);
  await page.waitForTimeout(500);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  await popup.locator('.tabRow .modeButton', { hasText: 'Monitor' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.toggleRow', { hasText: 'Monitor page for changes' }).locator('input[type="checkbox"]').click();
  await popup.waitForTimeout(200);
  await popup.locator('#monitor-keywords').fill('in stock');
  await popup.waitForTimeout(200);

  await popup.locator('.tabRow .modeButton', { hasText: 'Automation' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.toggleRow', { hasText: 'Auto-click keyword link' }).locator('input[type="checkbox"]').click();
  await popup.waitForTimeout(200);

  await popup.getByText('Start refreshing').click();

  // Poll for the navigation instead of a fixed sleep: the content script's
  // scan runs on a 1s interval, so a single flat wait races the poll cadence
  // and can read "not yet triggered" before the click's navigation lands.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !page.url().includes('/target')) {
    await page.waitForTimeout(200);
  }

  const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  console.log('storage dump:', JSON.stringify(storageDump, null, 2));

  const finalUrl = page.url();
  console.log('page url after monitor triggered:', finalUrl);
  const pass = finalUrl.includes('/target');

  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
