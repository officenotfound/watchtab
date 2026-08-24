// Automated smoke test: captcha detection heuristic (iframe/div markers + visible text)
// fires a detection, updates state, and sends a desktop notification.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

// Contains both a recognizable captcha widget class ("g-recaptcha") and the
// "verify you are human" text marker, matching the detection heuristic.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body>
    <h1>Are you human?</h1>
    <div class="g-recaptcha" data-sitekey="fake"></div>
    <p>Please verify you are human before continuing.</p>
  </body></html>`);
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
  page.on('console', (msg) => console.log('[page]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[page error]', err.message));
  await page.goto(TEST_URL);
  await page.waitForTimeout(500);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('console', (msg) => console.log('[popup]', msg.type(), msg.text()));
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  const captchaToggle = popup
    .locator('.toggleRow', { hasText: 'Detect Captcha on Page' })
    .locator('input[type="checkbox"]');
  await captchaToggle.click();
  await popup.waitForTimeout(300);

  const soundToggle = popup
    .locator('.toggleRow', { hasText: 'Play Alarm on Captcha Detection' })
    .locator('input[type="checkbox"]');
  await soundToggle.click();
  await popup.waitForTimeout(300);

  // Content script polls every 1s; give it a few cycles to detect and round-trip
  // through the background worker.
  await popup.waitForTimeout(3000);

  const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  const tabState = Object.values(storageDump).find((v) => v && v.siteConditions);
  console.log('siteConditionsState:', JSON.stringify(tabState?.siteConditionsState));

  const notifications = await sw.evaluate(
    () => new Promise((resolve) => chrome.notifications.getAll((all) => resolve(all))),
  );
  console.log('active notifications:', JSON.stringify(notifications));

  const offscreenContexts = await sw.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then((c) => c.length),
  );
  console.log('offscreen document contexts:', offscreenContexts);

  const detected = tabState?.siteConditionsState?.captchaDetected === true;
  const hasNotification = Object.keys(notifications).some((id) => id.includes('watchtab-condition-captcha'));
  const offscreenCreated = offscreenContexts > 0;

  const pass = detected && hasNotification && offscreenCreated;
  if (!pass) {
    console.log(`OBSERVED: detected=${detected}, hasNotification=${hasNotification}, offscreenCreated=${offscreenCreated}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
