// Ad-hoc smoke check (not part of the numbered suite): popup opens and all 5
// tabs, including the new Settings tab, are clickable and show their content.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

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
  console.log('extension id:', extId);

  const page = await context.newPage();
  await page.goto(TEST_URL);
  await page.waitForTimeout(300);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.waitForTimeout(500);

  const tabs = ['Refresh', 'Monitor', 'Automation', 'Conditions', 'Settings'];
  let allOk = true;
  for (const label of tabs) {
    const btn = popup.locator('.tabRow .modeButton', { hasText: label });
    await btn.click();
    await popup.waitForTimeout(150);
    const isActive = await btn.evaluate((el) => el.classList.contains('active'));
    console.log(`tab "${label}" clicked, active class present: ${isActive}`);
    if (!isActive) allOk = false;
  }

  // Settings-specific content checks.
  await popup.locator('.tabRow .modeButton', { hasText: 'Settings' }).click();
  await popup.waitForTimeout(150);
  const rangeCount = await popup.locator('input[type="range"]').count();
  const swatchCount = await popup.locator('.swatch').count();
  const brandMarkCount = await popup.locator('svg.brandMark').count();
  const brandTextCount = await popup.locator('p.brand').count();
  console.log('glass transparency slider present:', rangeCount === 1);
  console.log('accent color swatches present:', swatchCount === 5);
  console.log('logo mark svg present:', brandMarkCount === 1);
  console.log('old text-only brand element removed:', brandTextCount === 0);

  if (!allOk || rangeCount !== 1 || swatchCount !== 5 || brandMarkCount !== 1 || brandTextCount !== 0) {
    console.log('\nRESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('\nRESULT: PASS');
  }
} finally {
  await context.close();
  server.close();
}
