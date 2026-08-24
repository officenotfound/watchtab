// Skip Repeated Keyword: ON (default) means a continuously-present keyword should NOT
// keep re-triggering (lastTriggerAt stays fixed). OFF + forced retrigger (remove+re-add
// text) should advance lastTriggerAt.
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
  await popup.waitForTimeout(1500); // trigger #1 (found, transition)

  const dump = async () => {
    const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
    return Object.values(storageDump).find((v) => v && v.monitor);
  };

  let tabState = await dump();
  console.log('skipRepeat default:', tabState?.monitor?.skipRepeat, 'lastTriggerAt after first match:', tabState?.monitorState?.lastTriggerAt);
  const skipRepeatDefaultOn = tabState?.monitor?.skipRepeat === true;
  const firstTriggerAt = tabState?.monitorState?.lastTriggerAt;

  await page.waitForTimeout(2000); // keyword stays present, multiple scans occur
  tabState = await dump();
  const secondTriggerAt = tabState?.monitorState?.lastTriggerAt;
  console.log('lastTriggerAt after 2s more (skipRepeat ON, still present):', secondTriggerAt);
  const didNotAdvanceWithSkipOn = firstTriggerAt === secondTriggerAt;

  // Turn skip-repeat OFF.
  const skipRepeatToggle = popup
    .locator('.toggleRow', { hasText: 'Skip repeated keyword' })
    .locator('input[type="checkbox"]');
  await skipRepeatToggle.click();
  await popup.waitForTimeout(300);

  tabState = await dump();
  console.log('skipRepeat now:', tabState?.monitor?.skipRepeat);

  // Force a retrigger: remove then re-add the keyword text across two scan cycles.
  await page.evaluate(() => { document.querySelector('#target').textContent = 'nothing here'; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector('#target').textContent = 'the widget is here again'; });
  await page.waitForTimeout(1500);

  tabState = await dump();
  const thirdTriggerAt = tabState?.monitorState?.lastTriggerAt;
  console.log('lastTriggerAt after retrigger with skipRepeat OFF:', thirdTriggerAt);
  const advancedWithSkipOff = typeof thirdTriggerAt === 'number' && thirdTriggerAt > secondTriggerAt;

  const pass = skipRepeatDefaultOn && didNotAdvanceWithSkipOn && advancedWithSkipOff;
  if (!pass) {
    console.log('EXPECTED: skipRepeat default true; lastTriggerAt unchanged while ON and keyword stays present; lastTriggerAt advances after toggling OFF and retriggering');
    console.log(`OBSERVED: skipRepeatDefaultOn=${skipRepeatDefaultOn}, firstTriggerAt=${firstTriggerAt}, secondTriggerAt=${secondTriggerAt}, thirdTriggerAt=${thirdTriggerAt}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
