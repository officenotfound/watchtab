// Automated smoke test: error-page detection via the observational webRequest
// main-frame status hook (background.ts), independent of the content-script
// text fallback.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

// Serves a normal 200 page first, then flips to a 404 response so we can
// observe the transition from "not detected" to "detected" on a real refresh.
let respond404 = false;
const server = http.createServer((req, res) => {
  if (respond404) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>404</h1><p>Page not found.</p></body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>All good</h1></body></html>`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const TEST_URL = `http://127.0.0.1:${port}/`;

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false, // kept false: Playwright's own 'headless: true' breaks MV3 extension loading here; '--headless=new' below forces true headless instead (no OS window) while extensions still work.
  permissions: ['notifications'],
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

  await popup.locator('.tabRow .modeButton', { hasText: 'Conditions' }).click();
  await popup.waitForTimeout(200);

  const errorToggle = popup
    .locator('.toggleRow', { hasText: 'Detect Error Pages' })
    .locator('input[type="checkbox"]');
  await errorToggle.click();
  await popup.waitForTimeout(300);

  const dump = async () => {
    const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
    return Object.values(storageDump).find((v) => v && v.siteConditions);
  };

  const before = await dump();
  console.log('errorDetected before 404:', before?.siteConditionsState?.errorDetected);

  // Flip the server to 404 and reload the tab, so webRequest observes the
  // main-frame response status for this navigation.
  respond404 = true;
  await page.reload();
  await page.bringToFront();
  await popup.waitForTimeout(2500);

  const after = await dump();
  console.log('siteConditionsState after 404:', JSON.stringify(after?.siteConditionsState));

  const notifications = await sw.evaluate(
    () => new Promise((resolve) => chrome.notifications.getAll((all) => resolve(all))),
  );
  console.log('active notifications:', JSON.stringify(notifications));

  const detected = after?.siteConditionsState?.errorDetected === true;
  const statusRecorded = after?.siteConditionsState?.lastStatusCode === 404;
  const hasNotification = Object.keys(notifications).some((id) => id.includes('watchtab-condition-error'));

  const pass = detected && statusRecorded && hasNotification;
  if (!pass) {
    console.log(`OBSERVED: detected=${detected}, statusRecorded=${statusRecorded}, hasNotification=${hasNotification}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
