// Automated smoke test: plain-keyword "found" monitoring + auto-stop-refresh-on-alert.
// Launches a real Chromium with the unpacked extension loaded, no manual clicking.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

// Tiny local test page so we control the exact text and don't depend on the network.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Test Page</h1><p id="target">the widget is here</p></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const TEST_URL = `http://127.0.0.1:${port}/`;

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false, // kept false: Playwright's own 'headless: true' breaks MV3 extension loading here; '--headless=new' below forces true headless instead (no OS window) while extensions still work.
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--headless=new',
  ],
});

try {
  // Find the extension's service worker to read its ID.
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

  // The popup's own init() resolves the "current" tab via
  // browser.tabs.query({active:true, currentWindow:true}), so the test page
  // must be (and remain) the active tab in this window. Opening the popup as
  // a normal tab and never focusing it works fine: Playwright drives it over
  // CDP regardless of OS-level focus.
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('console', (msg) => console.log('[popup]', msg.type(), msg.text()));
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);

  // A new tab auto-focuses itself, which would make the popup register state
  // on its own tab instead of the test page (a real popup is an anchored
  // window, not a tab, so this quirk doesn't happen in normal browser use).
  // Re-focus the test page, then reload the popup so its init() re-resolves
  // the active tab correctly. Playwright can still drive the popup over CDP
  // afterwards without it being OS-frontmost.
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  await popup.locator('.tabRow .modeButton', { hasText: 'Monitor' }).click();
  await popup.waitForTimeout(200);

  const monitorToggle = popup
    .locator('.toggleRow', { hasText: 'Monitor page for changes' })
    .locator('input[type="checkbox"]');
  await monitorToggle.click();
  await popup.waitForTimeout(300);

  const keywordBox = popup.locator('#monitor-keywords');
  await keywordBox.waitFor({ state: 'visible', timeout: 5000 });
  await keywordBox.fill('widget');
  await popup.waitForTimeout(200);

  // alertMode defaults to 'found' already; start refreshing so we can observe auto-stop.
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(4000); // give the 1s content-script poll a few cycles

  const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  console.log('storage dump:', JSON.stringify(storageDump, null, 2));

  const tabsList = await sw.evaluate(
    () => new Promise((resolve) => chrome.tabs.query({}, (tabs) => resolve(tabs.map((t) => ({ id: t.id, url: t.url, active: t.active }))))),
  );
  console.log('open tabs (from sw):', JSON.stringify(tabsList));

  const statusText = await popup.locator('.status').last().innerText();
  console.log('popup status after scan:', JSON.stringify(statusText));

  const startStopLabel = await popup.locator('button.primaryButton').last().innerText();
  console.log('start/stop button now reads:', JSON.stringify(startStopLabel));

  const overlayText = await page.locator('#watchtab-countdown-overlay').innerText().catch(() => '(overlay not present)');
  console.log('on-page overlay text:', JSON.stringify(overlayText));

  const highlighted = await page.locator('mark.watchtab-highlight').count();
  console.log('highlighted <mark> elements on page:', highlighted);

  const pass =
    statusText.toLowerCase().includes('matching') &&
    !statusText.toLowerCase().includes('not matching') &&
    startStopLabel.toLowerCase().includes('start refreshing'); // should have auto-stopped

  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
