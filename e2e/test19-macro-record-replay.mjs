// Macro replay: directly set macro steps via the popup's JSON textarea (more
// reliable than simulating real recording input) and verify each step type
// actually executes against the page — click, fill, wait (roughly the right
// duration), and navigate.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test19');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url === '/next') {
    res.end(`<!doctype html><html><body><h1>Next Page</h1></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
    <h1>Test Page</h1>
    <input id="name" type="text" value="" />
    <button id="go" onclick="document.getElementById('log').textContent='clicked'">Go</button>
    <p id="log">idle</p>
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
  await popup.locator('.toggleRow', { hasText: 'Run macro' }).locator('input[type="checkbox"]').click();
  await popup.waitForTimeout(200);

  const steps = [
    { type: 'fill', selector: '#name', value: 'watchtab' },
    { type: 'click', selector: '#go' },
    { type: 'wait', durationMs: 1500 },
    { type: 'navigate', url: `${TEST_URL}next` },
  ];
  await popup.locator('textarea[placeholder^="[{"]').fill(JSON.stringify(steps));
  await popup.locator('.chip', { hasText: 'Save JSON' }).click();
  await popup.waitForTimeout(300);

  const waitStart = Date.now();

  // Trigger a real refresh so content.ts re-injects and runs the
  // 'each-refresh' macro trigger (the default) against the fresh page.
  await popup.getByText('Start refreshing').click();
  await popup.waitForTimeout(500);
  await page.reload();

  // Poll for the fill+click to land (they fire before the 1.5s wait step).
  let nameValue = '';
  let logValue = '';
  for (let i = 0; i < 20; i++) {
    nameValue = await page.locator('#name').inputValue().catch(() => '');
    logValue = await page.locator('#log').innerText().catch(() => '');
    if (nameValue && logValue === 'clicked') break;
    await page.waitForTimeout(150);
  }
  console.log('name value after fill step:', JSON.stringify(nameValue));
  console.log('log value after click step:', JSON.stringify(logValue));
  const fillAndClickWorked = nameValue === 'watchtab' && logValue === 'clicked';

  // Now wait for the navigate step, which only fires after the 1.5s wait step.
  await page.waitForURL('**/next', { timeout: 8000 }).catch(() => undefined);
  const elapsedMs = Date.now() - waitStart;
  console.log('final page url:', page.url(), 'elapsed ms since macro start:', elapsedMs);
  const navigated = page.url().includes('/next');
  // The wait step (1500ms) plus two ~200ms inter-step gaps means navigate
  // shouldn't fire before roughly 1.5s from macro start; generous floor to
  // avoid flakiness while still catching a wait step that's a no-op.
  const waitStepRespected = elapsedMs > 1200;

  const pass = fillAndClickWorked && navigated && waitStepRespected;
  if (!pass) {
    console.log('EXPECTED: fill+click land quickly, then navigate to /next only after >1.2s');
    console.log(`OBSERVED: fillAndClickWorked=${fillAndClickWorked}, navigated=${navigated}, waitStepRespected=${waitStepRespected} (elapsed=${elapsedMs}ms)`);
  }
  console.log(pass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
