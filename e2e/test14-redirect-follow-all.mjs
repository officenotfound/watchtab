// Automated smoke test: "Follow All Redirects" (default) keeps refreshing the
// tab even after it has navigated away from its original URL via a 302.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

// "/" always 302s to "/landing"; "/landing" serves a normal page.
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(302, { Location: '/landing' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Landing page</h1></body></html>`);
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
  sw.on('console', (msg) => console.log('[sw]', msg.type(), msg.text()));

  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('[page error]', err.message));
  await page.goto(TEST_URL);
  await page.waitForTimeout(500);
  console.log('landed on:', page.url());
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  // Redirect behavior defaults to "Follow All Redirects" — no toggle needed.
  // Use the fastest fixed preset (5s) to observe multiple refresh cycles quickly.
  await popup.getByText('5s', { exact: true }).click();
  await popup.waitForTimeout(200);
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(300);

  const dump = async () => {
    const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
    return Object.values(storageDump).find((v) => v && v.siteConditions);
  };

  // Wait past one refresh interval so the background worker has reloaded the tab.
  await page.waitForTimeout(6500);
  await page.bringToFront();

  const state = await dump();
  console.log('page url after wait:', page.url());
  console.log('siteConditionsState:', JSON.stringify(state?.siteConditionsState));
  console.log('active:', state?.active, 'refreshCount:', state?.refreshCount);

  const stillActive = state?.active === true;
  const refreshed = (state?.refreshCount ?? 0) >= 1;
  const notStopped = state?.siteConditionsState?.redirected !== true;

  const pass = stillActive && refreshed && notStopped;
  if (!pass) {
    console.log(`OBSERVED: stillActive=${stillActive}, refreshed=${refreshed}, notStopped=${notStopped}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
