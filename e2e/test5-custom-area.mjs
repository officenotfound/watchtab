// Custom-area scope: element picker fills the selector, then only mutations inside
// the picked element (#price) should affect matching, not the sibling (#other).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body>
    <h1>Test Page</h1>
    <div id="price">$19.99</div>
    <div id="other">unrelated text $99.99</div>
  </body></html>`);
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

  await popup.locator('.modeButton', { hasText: 'Custom area' }).click();
  await popup.waitForTimeout(300);

  const selectorInput = popup.locator('input[placeholder="CSS selector"]');
  await selectorInput.waitFor({ state: 'visible', timeout: 5000 });

  await popup.locator('.chip', { hasText: 'Pick element' }).click();
  await popup.waitForTimeout(300);

  // Back on the real page, click the element we want picked.
  await page.bringToFront();
  await page.locator('#price').click();

  // Poll the popup's selector input until the picker result lands.
  let selectorValue = '';
  for (let i = 0; i < 20; i++) {
    selectorValue = await selectorInput.inputValue().catch(() => '');
    if (selectorValue) break;
    await popup.waitForTimeout(100);
  }
  console.log('auto-filled selector:', JSON.stringify(selectorValue));
  const pickedSelectorLooksRight = selectorValue.includes('price');

  const keywordBox = popup.locator('#monitor-keywords');
  await keywordBox.waitFor({ state: 'visible', timeout: 5000 });
  await keywordBox.fill('19.99');
  await popup.waitForTimeout(1500);

  let storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  let tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after keyword set, currentlyMatching:', tabState?.monitorState?.currentlyMatching, 'error:', tabState?.monitorState?.error);
  const matchedInitially = tabState?.monitorState?.currentlyMatching === true;

  // Mutate the sibling — should NOT affect matching since it's out of scope.
  await page.evaluate(() => { document.querySelector('#other').textContent = 'unrelated text changed, no 19.99 here'; });
  await page.waitForTimeout(1500);
  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after #other mutation, currentlyMatching:', tabState?.monitorState?.currentlyMatching);
  const stillMatchedAfterOtherMutation = tabState?.monitorState?.currentlyMatching === true;

  // Mutate the scoped element — SHOULD lose the match.
  await page.evaluate(() => { document.querySelector('#price').textContent = '$25.00'; });
  await page.waitForTimeout(1500);
  storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
  tabState = Object.values(storageDump).find((v) => v && v.monitor);
  console.log('after #price mutation, currentlyMatching:', tabState?.monitorState?.currentlyMatching);
  const noLongerMatchedAfterPriceMutation = tabState?.monitorState?.currentlyMatching === false;

  const pass = pickedSelectorLooksRight && matchedInitially && stillMatchedAfterOtherMutation && noLongerMatchedAfterPriceMutation;
  if (!pass) {
    console.log('EXPECTED: selector auto-fill contains "price"; match true initially; match stays true after #other mutation; match false after #price mutation');
    console.log(`OBSERVED: selector=${JSON.stringify(selectorValue)}, matchedInitially=${matchedInitially}, stillMatchedAfterOtherMutation=${stillMatchedAfterOtherMutation}, noLongerMatchedAfterPriceMutation=${noLongerMatchedAfterPriceMutation}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
