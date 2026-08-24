// Regression tests for the final QA pass: 4 confirmed high-severity bugs.
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../.output/chrome-mv3');
const USER_DATA_DIR = path.resolve(__dirname, '.profile-test22');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url === '/target') {
    res.end(`<!doctype html><html><body><h1>Landed</h1></body></html>`);
    return;
  }
  res.end(`<!doctype html><html><body>
    <div id="outside"><a id="outsideLink" href="/target">the widget is in stock now</a></div>
    <div id="scope"><p>nothing to click in here</p></div>
    <p id="price">$19.99</p>
  </body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const TEST_URL = `http://127.0.0.1:${port}/`;

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-first-run', '--headless=new'],
});

let allPass = true;
function check(name, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ': ' + detail : ''}`);
  if (!pass) allPass = false;
}

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;

  // ---- Bug 2 & 3 (matcher.ts, no browser needed for parsing, but XPath needs a DOM) ----
  const page = await context.newPage();
  await page.goto(TEST_URL);
  await page.waitForTimeout(300);
  await page.bringToFront();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForTimeout(500);

  await popup.locator('.tabRow .modeButton', { hasText: 'Monitor' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.toggleRow', { hasText: 'Monitor page for changes' }).locator('input[type="checkbox"]').click();
  await popup.waitForTimeout(200);

  // Bug 2: regex with a {m,n} quantifier containing a comma must not be split apart.
  await popup.locator('#monitor-keywords').fill('$\\$\\d{2,4}\\.\\d{2}');
  await popup.waitForTimeout(1200);
  let dump = await sw.evaluate(() => chrome.storage.local.get(null));
  let st = Object.values(dump)[0];
  check('Bug 2: {2,4} quantifier regex matches (not split into garbage)', st.monitorState.currentlyMatching === true, `matching=${st.monitorState.currentlyMatching} error=${st.monitorState.error}`);

  // Bug 3: XPath scoped to a custom area should NOT match something outside that area.
  await popup.locator('.tabRow .modeButton', { hasText: 'Monitor' }).click();
  await popup.locator('.modeRow', { hasText: 'Full page' }).getByText('Custom area').click();
  await popup.waitForTimeout(200);
  const selectorInput = popup.locator('input[placeholder="CSS selector"]');
  await selectorInput.fill('#scope');
  await popup.waitForTimeout(200);
  await popup.locator('#monitor-keywords').fill('@@//a');
  await popup.waitForTimeout(1200);
  dump = await sw.evaluate(() => chrome.storage.local.get(null));
  st = Object.values(dump)[0];
  check('Bug 3: //a scoped to #scope does NOT match <a> outside it', st.monitorState.currentlyMatching === false, `currentlyMatching=${st.monitorState.currentlyMatching} (there is no <a> inside #scope, only outside it)`);

  // Reset scope to full page + real keyword for bug 1 test.
  await popup.locator('.modeRow', { hasText: 'Custom area' }).getByText('Full page').click();
  await popup.waitForTimeout(200);
  await popup.locator('#monitor-keywords').fill('in stock');
  await popup.waitForTimeout(200);

  // Bug 1: enable monitor+keyword FIRST (letting it match once, consuming the
  // notification's one-shot edge), THEN enable auto-click. Before the fix,
  // this exact ordering meant auto-click would never fire.
  await popup.waitForTimeout(2000); // let it match at least once before automation is armed
  await popup.locator('.tabRow .modeButton', { hasText: 'Automation' }).click();
  await popup.waitForTimeout(200);
  await popup.locator('.toggleRow', { hasText: 'Click additional elements' }).scrollIntoViewIfNeeded().catch(() => {});

  // Use click-targets (when-alert-triggers) rather than auto-click-keyword,
  // since auto-click-keyword already had its own fix verified elsewhere —
  // this specifically covers the click-targets/macro path from bug #1.
  await popup.getByText('Add manually', { exact: true }).click();
  await popup.waitForTimeout(200);
  const targetSelectorInputs = popup.locator('input[placeholder="CSS selector"]');
  const count = await targetSelectorInputs.count();
  await targetSelectorInputs.nth(count - 1).fill('#price');
  await popup.waitForTimeout(200);
  const triggerSelects = popup.locator('select');
  const selCount = await triggerSelects.count();
  await triggerSelects.nth(selCount - 1).selectOption('when-alert-triggers');
  await popup.waitForTimeout(200);

  await page.evaluate(() => {
    document.querySelector('#price').setAttribute('data-clicked', 'pending');
    document.querySelector('#price').addEventListener('click', () => {
      document.querySelector('#price').setAttribute('data-clicked', 'yes');
    });
  });

  await popup.waitForTimeout(2500);
  const clicked = await page.evaluate(() => document.querySelector('#price')?.getAttribute('data-clicked'));
  check('Bug 1: click-target with when-alert-triggers fires even though the match happened before automation was armed', clicked === 'yes', `data-clicked=${clicked}`);

  // ---- Bug 4: picker-result no longer races with concurrent monitor-scan writes ----
  // Monitoring is already running continuously in the background at this
  // point (~1 scan/sec), which is exactly the concurrent writer that used to
  // be able to clobber picker-result's un-queued read-modify-write. Use the
  // real picker flow (proven pattern from test5-custom-area.mjs) while that
  // background scanning is active, then confirm BOTH the picked selector
  // AND monitor.enabled survived — i.e. neither write clobbered the other.
  const clickTargetsBefore = (await sw.evaluate(() => chrome.storage.local.get(null)));
  const beforeCount = Object.values(clickTargetsBefore)[0].automation.clickTargets.length;

  await popup.locator('.chip', { hasText: 'Pick target element' }).click();
  await popup.waitForTimeout(300);
  await page.locator('#outsideLink').click();
  await popup.waitForTimeout(1200);

  const afterPicker = await sw.evaluate(() => chrome.storage.local.get(null));
  const stAfter = Object.values(afterPicker)[0];
  const newTarget = stAfter.automation.clickTargets[stAfter.automation.clickTargets.length - 1];
  check(
    'Bug 4: picker-result write survives concurrent monitor-scan writes (monitor still enabled, new click target added with correct selector)',
    stAfter.monitor.enabled === true &&
      stAfter.automation.clickTargets.length === beforeCount + 1 &&
      newTarget?.selector === '#outsideLink',
    `monitor.enabled=${stAfter.monitor.enabled} clickTargets=${stAfter.automation.clickTargets.length} newSelector=${newTarget?.selector}`,
  );

  console.log(allPass ? '\nRESULT: PASS' : '\nRESULT: FAIL');
} finally {
  await context.close();
  server.close();
}
