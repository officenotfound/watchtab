// Click additional elements: a manually-added click target with trigger
// 'each-refresh' should get clicked once the content script loads (which is
// what "each refresh" means from a fresh page load).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test17');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body>
    <h1>Test Page</h1>
    <button id="accept" onclick="document.getElementById('status').textContent='clicked'">Accept</button>
    <p id="status">not clicked</p>
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

  await popup.locator('.tabRow .modeButton', { hasText: 'Automation' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.chip', { hasText: 'Add manually' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('input[placeholder="CSS selector"]').fill('#accept');
  await popup.waitForTimeout(300);

  // Trigger a real refresh so the content script re-injects and runs its
  // "each refresh" automation pass against the freshly-loaded page.
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(500);
  await page.reload();
  await page.waitForTimeout(1500);

  const statusText = await page.locator('#status').innerText();
  console.log('status element text after reload:', statusText);
  const pass = statusText === 'clicked';

  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
