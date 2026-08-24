// Automated smoke test: "Follow Canonical URL" stops refreshing and fires a
// notification once the tab navigates away (via a 302) from the URL that was
// current when refreshing started.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile');

const server = http.createServer((req, res) => {
  if (req.url === '/page-a') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>Page A</h1></body></html>`);
    return;
  }
  if (req.url === '/go') {
    res.writeHead(302, { Location: '/page-b' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html><body><h1>Page B</h1></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const PAGE_A_URL = `http://127.0.0.1:${port}/page-a`;

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
  await page.goto(PAGE_A_URL);
  await page.waitForTimeout(500);
  await page.bringToFront();

  const popup = await context.newPage();
  popup.on('pageerror', (err) => console.log('[popup error]', err.message));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  await popup.getByText('Follow Canonical URL').click();
  await popup.waitForTimeout(300);

  await popup.getByText('5s', { exact: true }).click();
  await popup.waitForTimeout(200);
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(500);

  const dump = async () => {
    const storageDump = await sw.evaluate(() => chrome.storage.local.get(null));
    return Object.values(storageDump).find((v) => v && v.siteConditions);
  };

  const started = await dump();
  console.log('originUrl captured at start:', started?.siteConditions?.originUrl);

  // Simulate the page redirecting on its own (e.g. session expiry, canonical
  // redirect) — not an extension-initiated reload.
  await page.evaluate(() => {
    location.href = '/go';
  });
  await page.waitForTimeout(1500);
  await page.bringToFront();

  console.log('page url after redirect:', page.url());

  const after = await dump();
  console.log('siteConditionsState after redirect:', JSON.stringify(after?.siteConditionsState));
  console.log('active after redirect:', after?.active);

  const notifications = await sw.evaluate(
    () => new Promise((resolve) => chrome.notifications.getAll((all) => resolve(all))),
  );
  console.log('active notifications:', JSON.stringify(notifications));

  const stopped = after?.active === false;
  const flagged = after?.siteConditionsState?.redirected === true;
  const hasNotification = Object.keys(notifications).some((id) => id.includes('watchtab-condition-redirect'));

  const pass = stopped && flagged && hasNotification;
  if (!pass) {
    console.log(`OBSERVED: stopped=${stopped}, flagged=${flagged}, hasNotification=${hasNotification}`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
