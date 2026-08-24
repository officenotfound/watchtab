import { browser } from 'wxt/browser';
import {
  getAllTabStates,
  getAppearanceSettings,
  getTabState,
  removeTabState,
  setAppearanceSettings,
  setTabState,
} from '@/lib/storage';
import { ACCENT_COLOR_VALUES } from '@/lib/appearance';
import {
  createDefaultSiteConditionsState,
  createDefaultState,
  resolveIntervalSeconds,
  type ContentCommand,
  type CookieRule,
  type CookieRuleTiming,
  type MonitorRuntimeState,
  type MonitorTriggerKind,
  type RuntimeMessage,
  type SiteConditionKind,
  type TabWatchState,
} from '@/lib/types';

/**
 * chrome.alarms clamps any delay under 30s to 30s, which breaks the
 * sub-30-second presets (5s/10s/15s). So in-memory setTimeout is the
 * primary scheduler, kept alive by a long-lived port the content script
 * holds open while a tab is actively refreshing. A single low-frequency
 * alarm exists only to re-arm timers if the service worker gets killed
 * and restarted (idle eviction, browser relaunch) between refreshes.
 */
const HEARTBEAT_ALARM = 'watchtab-heartbeat';
const HEARTBEAT_MINUTES = 0.5; // Chrome's practical floor for repeating alarms.

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const ports = new Map<number, ReturnType<typeof browser.runtime.connect>>();

/**
 * Per-tab serialization for read-modify-write access to a tab's storage
 * record. The content script's ~1s scan loop can produce several
 * 'monitor-scan' messages in quick succession; each handler does
 * getTabState() then setTabState({...state, ...}), and without this queue
 * two overlapping calls can interleave their fetch/write so a later,
 * non-triggering scan silently clobbers a stop-refreshing write that a
 * concurrent triggering scan's fireMonitorAlert() just made — observed as
 * an intermittent, timing-dependent failure to stop on alert, not a
 * deterministic bug, which is what made it easy to miss in early testing.
 */
const tabQueues = new Map<number, Promise<unknown>>();

function enqueueForTab<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const prior = tabQueues.get(tabId) ?? Promise.resolve();
  const settled = prior.then(task, task);
  tabQueues.set(
    tabId,
    settled.catch(() => undefined),
  );
  return settled;
}

function clearTimer(tabId: number): void {
  const handle = timers.get(tabId);
  if (handle !== undefined) {
    clearTimeout(handle);
    timers.delete(tabId);
  }
}

function armTimer(tabId: number, delayMs: number): void {
  clearTimer(tabId);
  timers.set(
    tabId,
    setTimeout(() => void enqueueForTab(tabId, () => handleRefreshDue(tabId)), Math.max(0, delayMs)),
  );
}

async function scheduleNext(state: TabWatchState): Promise<void> {
  const seconds = resolveIntervalSeconds(state.interval);
  const nextRefreshAt = Date.now() + seconds * 1000;
  await setTabState({ ...state, nextRefreshAt });
  armTimer(state.tabId, seconds * 1000);
}

async function stopWatching(tabId: number): Promise<void> {
  clearTimer(tabId);
  const state = await getTabState(tabId);
  if (state) {
    await setTabState({ ...state, active: false, paused: false, nextRefreshAt: null });
  }
  await recomputeBadge();
}

async function pauseWatching(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || state.paused) return;
  clearTimer(tabId);
  await setTabState({ ...state, paused: true, nextRefreshAt: null });
  await recomputeBadge();
}

async function resumeWatching(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || !state.paused) return;
  await scheduleNext({ ...state, paused: false });
  await recomputeBadge();
}

async function startWatching(tabId: number, settings: Partial<TabWatchState>): Promise<void> {
  const existing = (await getTabState(tabId)) ?? createDefaultState(tabId);
  let originUrl = existing.siteConditions.originUrl;
  try {
    const tab = await browser.tabs.get(tabId);
    originUrl = tab.url ?? null;
  } catch {
    // Tab lookup can fail in edge cases (e.g. tab mid-close); fall back to whatever was stored.
  }
  const mergedSiteConditions = { ...existing.siteConditions, ...settings.siteConditions, originUrl };
  const next: TabWatchState = {
    ...existing,
    ...settings,
    tabId,
    active: true,
    paused: false,
    refreshCount: 0,
    siteConditions: mergedSiteConditions,
    siteConditionsState: createDefaultSiteConditionsState(),
  };
  await scheduleNext(next);
  await recomputeBadge();
}

/** Persists settings whether or not the tab is currently refreshing, and reschedules live if it is. */
async function updateSettings(tabId: number, settings: Partial<TabWatchState>): Promise<void> {
  const existing = (await getTabState(tabId)) ?? createDefaultState(tabId);
  const next: TabWatchState = { ...existing, ...settings, tabId };
  // The popup only ever sends back the last state it saw for `originUrl`; preserve
  // whatever the background worker actually captured at refresh-start time instead.
  next.siteConditions = { ...next.siteConditions, originUrl: existing.siteConditions.originUrl };
  await setTabState(next);
  if (next.active && !next.paused) {
    await scheduleNext(next);
  }
  await recomputeBadge();
}

/** Applies every cookie rule for the given timing against the tab's current URL. */
async function applyCookieRules(url: string, rules: CookieRule[], timing: CookieRuleTiming): Promise<void> {
  const matching = rules.filter((r) => r.timing === timing);
  for (const rule of matching) {
    try {
      if (rule.action === 'set') {
        await browser.cookies.set({ url, name: rule.name, value: rule.value });
      } else {
        await browser.cookies.remove({ url, name: rule.name });
      }
    } catch (err) {
      console.error('watchtab: cookie rule failed', rule, err);
    }
  }
}

/**
 * Waits for the tab's main-frame navigation to finish loading (status
 * 'complete'). More correct than a fixed delay: 'after-refresh' cookie rules
 * are meant to apply once the freshly-reloaded page has actually settled, and
 * load time varies a lot page to page. Capped at 15s so a page that never
 * reaches 'complete' (e.g. a long-polling tab) can't stall the refresh cycle.
 */
function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: { status?: string }) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

async function handleRefreshDue(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || state.paused) return;

  if (state.refreshLimit !== null && state.refreshCount >= state.refreshLimit) {
    await stopWatching(tabId);
    return;
  }

  let tabUrl: string | null = null;
  try {
    const tab = await browser.tabs.get(tabId);
    tabUrl = tab.url ?? null;
  } catch {
    // Tab may have closed; fall through, cookie rules just get skipped below.
  }

  if (tabUrl && state.cookieRules.some((r) => r.timing === 'before-refresh')) {
    await applyCookieRules(tabUrl, state.cookieRules, 'before-refresh');
  }

  try {
    await browser.tabs.reload(tabId, { bypassCache: state.hardRefresh });
  } catch {
    // Tab may have closed between the timer firing and the reload call.
    await removeTabState(tabId);
    clearTimer(tabId);
    return;
  }

  if (tabUrl && state.cookieRules.some((r) => r.timing === 'after-refresh')) {
    await waitForTabLoad(tabId);
    await applyCookieRules(tabUrl, state.cookieRules, 'after-refresh');
  }

  const updated: TabWatchState = { ...state, refreshCount: state.refreshCount + 1 };

  if (updated.refreshLimit !== null && updated.refreshCount >= updated.refreshLimit) {
    await setTabState({ ...updated, active: false, nextRefreshAt: null });
    clearTimer(tabId);
    await recomputeBadge();
    return;
  }

  await scheduleNext(updated);
}

async function sendToContent(tabId: number, command: ContentCommand): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, command);
  } catch {
    // Content script may not be injected on this page (e.g. chrome:// URLs).
  }
}

function alertMessage(kind: MonitorTriggerKind): string {
  switch (kind) {
    case 'found':
      return 'A configured keyword was found on the page.';
    case 'lost':
      return 'A previously matching keyword is no longer on the page.';
    case 'any-change':
      return 'The monitored area of the page changed.';
  }
}

async function fireMonitorAlert(tabId: number, state: TabWatchState, kind: MonitorTriggerKind): Promise<void> {
  try {
    await browser.notifications.create(`watchtab-monitor-${tabId}-${Date.now()}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: 'Page Monitor',
      message: alertMessage(kind),
    });
  } catch (err) {
    // Logged rather than swallowed: a failure here is usually the OS or
    // browser blocking notification permission, which is worth surfacing
    // in the service worker console rather than failing invisibly.
    console.error('watchtab: notifications.create failed', err);
  }

  if (state.monitor.windowFocus) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.windowId !== undefined) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
      await browser.tabs.update(tabId, { active: true });
    } catch (err) {
      console.error('watchtab: window focus on detection failed', err);
    }
  }
}

async function handleMonitorScan(
  tabId: number,
  monitorState: MonitorRuntimeState,
  triggered: boolean,
  triggerKind: MonitorTriggerKind | null,
  stopRefreshRequested: boolean,
): Promise<void> {
  const state = await getTabState(tabId);
  if (!state) return;

  const updated: TabWatchState = {
    ...state,
    monitorState: triggered && triggerKind
      ? { ...monitorState, lastTriggerAt: Date.now(), lastTriggerKind: triggerKind }
      : monitorState,
  };
  await setTabState(updated);

  if (triggered && triggerKind) {
    await fireMonitorAlert(tabId, updated, triggerKind);
  }

  // Computed fresh every scan (see the stopRefreshRequested doc comment in
  // lib/types.ts) rather than tied to the one-shot trigger above, so it
  // still fires even if that edge already came and went before "Start
  // refreshing" was clicked. stopWatching is idempotent, so re-asserting it
  // on every matching scan is safe.
  if (stopRefreshRequested && updated.active) {
    await stopWatching(tabId);
  }
}

// ---- site conditions: captcha / error / redirect -------------------------

const OFFSCREEN_URL = 'offscreen.html';
let offscreenReady: Promise<void> | null = null;

/** Lazily creates the (single, shared) offscreen document used for alert-sound playback. */
async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    // Untyped: the offscreen API isn't in the shared browser.* type surface this
    // codebase targets (and doesn't exist at all in Firefox), so it's accessed
    // dynamically and no-ops where unavailable.
    const runtimeAny = browser.runtime as unknown as Record<string, (...args: unknown[]) => unknown>;
    const offscreenApi = (
      browser as unknown as Record<string, { createDocument: (opts: Record<string, unknown>) => Promise<unknown> }>
    ).offscreen;
    if (!offscreenApi) return;
    try {
      const getContexts = runtimeAny.getContexts as
        | ((filter: Record<string, unknown>) => Promise<unknown[]>)
        | undefined;
      if (getContexts) {
        const existingContexts = await getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [browser.runtime.getURL(`/${OFFSCREEN_URL}` as never)],
        });
        if (existingContexts.length > 0) return;
      }
      await offscreenApi.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a short local alert tone when captcha or error detection triggers.',
      });
    } catch (err) {
      // "Only a single offscreen document may be created" races are harmless; anything else is worth logging.
      if (!(err instanceof Error) || !err.message.includes('single offscreen document')) {
        console.error('watchtab: offscreen document creation failed', err);
      }
    }
  })();
  return offscreenReady;
}

async function playAlertSound(): Promise<void> {
  try {
    await ensureOffscreenDocument();
    await browser.runtime.sendMessage({ type: 'play-alert-sound' });
  } catch (err) {
    console.error('watchtab: play-alert-sound failed', err);
  }
}

function siteConditionMessage(kind: SiteConditionKind, statusCode?: number | null): string {
  switch (kind) {
    case 'captcha':
      return 'A captcha challenge was detected on the page.';
    case 'error':
      return statusCode
        ? `The page responded with an error (status ${statusCode}).`
        : 'The page looks like an error page.';
    case 'redirect':
      return 'The page redirected away from its original URL. Refresh stopped.';
  }
}

async function fireSiteConditionAlert(
  tabId: number,
  kind: SiteConditionKind,
  playSound: boolean,
  statusCode?: number | null,
): Promise<void> {
  try {
    await browser.notifications.create(`watchtab-condition-${kind}-${tabId}-${Date.now()}`, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: 'Site Conditions',
      message: siteConditionMessage(kind, statusCode),
    });
  } catch (err) {
    console.error('watchtab: notifications.create failed', err);
  }
  if (playSound) void playAlertSound();
}

/** Called from the content script's scan cycle with captcha/error heuristic results. */
async function handleSiteConditionScan(
  tabId: number,
  captchaDetected: boolean,
  errorDetected: boolean,
): Promise<void> {
  const state = await getTabState(tabId);
  if (!state) return;

  const prev = state.siteConditionsState;
  const captchaNewlyDetected = state.siteConditions.captchaDetection && captchaDetected && !prev.captchaDetected;
  const errorNewlyDetected = state.siteConditions.errorDetection && errorDetected && !prev.errorDetected;

  const updated = {
    ...state,
    siteConditionsState: {
      ...prev,
      captchaDetected: state.siteConditions.captchaDetection ? captchaDetected : false,
      errorDetected: state.siteConditions.errorDetection ? errorDetected : prev.errorDetected,
      lastDetectionAt: captchaNewlyDetected || errorNewlyDetected ? Date.now() : prev.lastDetectionAt,
      lastDetectionKind: captchaNewlyDetected ? 'captcha' : errorNewlyDetected ? 'error' : prev.lastDetectionKind,
    },
  };
  await setTabState(updated);

  if (captchaNewlyDetected) {
    await fireSiteConditionAlert(tabId, 'captcha', state.siteConditions.captchaSound);
  }
  if (errorNewlyDetected) {
    await fireSiteConditionAlert(tabId, 'error', state.siteConditions.errorSound, updated.siteConditionsState.lastStatusCode);
  }
}

/** Records the observed HTTP status for a tab's main-frame navigation and alerts on 4xx/5xx. */
async function handleMainFrameStatus(tabId: number, statusCode: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state) return;

  const isError = statusCode >= 400;
  const prevState = state.siteConditionsState;
  const newlyDetected = state.siteConditions.errorDetection && isError && !prevState.errorDetected;

  const updated: TabWatchState = {
    ...state,
    siteConditionsState: {
      ...prevState,
      lastStatusCode: statusCode,
      errorDetected: state.siteConditions.errorDetection ? isError : prevState.errorDetected,
      lastDetectionAt: newlyDetected ? Date.now() : prevState.lastDetectionAt,
      lastDetectionKind: newlyDetected ? 'error' : prevState.lastDetectionKind,
    },
  };
  await setTabState(updated);

  if (newlyDetected) {
    await fireSiteConditionAlert(tabId, 'error', state.siteConditions.errorSound, statusCode);
  }
}

/** Enforces "Follow Canonical URL": stops refreshing if the tab navigated away from its captured origin URL. */
async function handleCanonicalNavigation(tabId: number, committedUrl: string): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active) return;
  if (state.siteConditions.redirectBehavior !== 'follow-canonical') return;
  if (!state.siteConditions.originUrl) return;

  let original: URL;
  let current: URL;
  try {
    original = new URL(state.siteConditions.originUrl);
    current = new URL(committedUrl);
  } catch {
    return;
  }

  const isSameLocation = original.origin === current.origin && original.pathname === current.pathname;
  if (isSameLocation) return;
  if (state.siteConditionsState.redirected) return; // Already handled this redirect.

  await stopWatching(tabId);
  const latest = await getTabState(tabId);
  if (latest) {
    await setTabState({
      ...latest,
      siteConditionsState: {
        ...latest.siteConditionsState,
        redirected: true,
        lastDetectionAt: Date.now(),
        lastDetectionKind: 'redirect',
      },
    });
  }
  await fireSiteConditionAlert(tabId, 'redirect', false);
}

/**
 * Recomputes the toolbar badge to reflect the count of distinct tabs that
 * are either actively refreshing or have monitoring enabled (whichever tab
 * matches either condition is counted once, not summed twice). Respects the
 * global `showBadgeCount` appearance setting, which lives outside per-tab
 * storage (see lib/storage.ts's APPEARANCE_KEY), so it's read separately.
 */
async function recomputeBadge(): Promise<void> {
  try {
    const appearance = await getAppearanceSettings();
    if (!appearance.showBadgeCount) {
      await browser.action.setBadgeText({ text: '' });
      return;
    }
    const all = await getAllTabStates();
    const count = all.filter((state) => state.active || state.monitor.enabled).length;
    await browser.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) {
      const accent = ACCENT_COLOR_VALUES[appearance.accentColor]?.dark ?? ACCENT_COLOR_VALUES.blue.dark;
      await browser.action.setBadgeBackgroundColor({ color: accent });
    }
  } catch (err) {
    console.error('watchtab: recomputeBadge failed', err);
  }
}

/** Re-arms in-memory timers from persisted state after a service worker restart. */
async function recoverActiveTimers(): Promise<void> {
  const all = await getAllTabStates();
  const now = Date.now();
  for (const state of all) {
    if (!state.active || state.paused || !state.nextRefreshAt) continue;
    if (timers.has(state.tabId)) continue;
    const remaining = state.nextRefreshAt - now;
    if (remaining <= 0) {
      void enqueueForTab(state.tabId, () => handleRefreshDue(state.tabId));
    } else {
      armTimer(state.tabId, remaining);
    }
  }
}

export default defineBackground(() => {
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  void recoverActiveTimers();
  void recomputeBadge();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM) void recoverActiveTimers();
  });

  browser.runtime.onStartup.addListener(() => void recoverActiveTimers());

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'watchtab-keepalive') return;
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined) return;
    ports.set(tabId, port);
    port.onDisconnect.addListener(() => {
      ports.delete(tabId);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    clearTimer(tabId);
    ports.delete(tabId);
    void removeTabState(tabId);
  });

  // Observational only (not blocking): reads the main-frame response status so
  // error detection doesn't rely solely on the content-script text heuristic.
  browser.webRequest.onCompleted.addListener(
    (details) => {
      if (details.type !== 'main_frame' || details.tabId < 0) return;
      void enqueueForTab(details.tabId, () => handleMainFrameStatus(details.tabId, details.statusCode));
    },
    { urls: ['<all_urls>'] },
  );

  browser.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return; // main frame only
    void enqueueForTab(details.tabId, () => handleCanonicalNavigation(details.tabId, details.url));
  });

  browser.runtime.onMessage.addListener(
    (message: RuntimeMessage, sender, sendResponse: (response: unknown) => void) => {
      switch (message.type) {
        case 'user-interaction': {
          const tabId = sender.tab?.id;
          if (tabId !== undefined) {
            void enqueueForTab(tabId, () => pauseWatching(tabId));
          }
          return false;
        }
        case 'get-appearance': {
          void getAppearanceSettings().then(sendResponse);
          return true;
        }
        case 'set-appearance': {
          void setAppearanceSettings(message.settings)
            .then(() => recomputeBadge())
            .then(() => sendResponse(true));
          return true;
        }
        case 'get-my-state': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse(null);
            return false;
          }
          void getTabState(tabId).then(sendResponse);
          return true;
        }
        case 'get-state': {
          void getTabState(message.tabId).then((state) => sendResponse(state ?? null));
          return true;
        }
        case 'start': {
          void enqueueForTab(message.tabId, () => startWatching(message.tabId, message.settings)).then(() =>
            sendResponse(true),
          );
          return true;
        }
        case 'stop': {
          void enqueueForTab(message.tabId, () => stopWatching(message.tabId)).then(() => sendResponse(true));
          return true;
        }
        case 'update-settings': {
          void enqueueForTab(message.tabId, () => updateSettings(message.tabId, message.settings)).then(() =>
            sendResponse(true),
          );
          return true;
        }
        case 'resume': {
          void enqueueForTab(message.tabId, () => resumeWatching(message.tabId)).then(() => sendResponse(true));
          return true;
        }
        case 'monitor-scan': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse(false);
            return false;
          }
          void enqueueForTab(tabId, () =>
            handleMonitorScan(
              tabId,
              message.monitorState,
              message.triggered,
              message.triggerKind,
              message.stopRefreshRequested,
            ),
          ).then(() => sendResponse(true));
          return true;
        }
        case 'site-condition-scan': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse(false);
            return false;
          }
          void enqueueForTab(tabId, () =>
            handleSiteConditionScan(tabId, message.captchaDetected, message.errorDetected),
          ).then(() => sendResponse(true));
          return true;
        }
        case 'start-picker': {
          void sendToContent(message.tabId, { type: 'enter-picker-mode', target: message.target }).then(() =>
            sendResponse(true),
          );
          return true;
        }
        case 'cancel-picker': {
          void sendToContent(message.tabId, { type: 'exit-picker-mode' }).then(() => sendResponse(true));
          return true;
        }
        case 'picker-result': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) {
            sendResponse(false);
            return false;
          }
          void (async () => {
            const existing = (await getTabState(tabId)) ?? createDefaultState(tabId);
            if (message.target === 'custom-area') {
              await setTabState({
                ...existing,
                monitor: { ...existing.monitor, scopeMode: 'custom-area', customSelector: message.selector },
              });
            } else {
              const id = `click-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
              await setTabState({
                ...existing,
                automation: {
                  ...existing.automation,
                  clickTargets: [
                    ...existing.automation.clickTargets,
                    { id, selector: message.selector, trigger: 'each-refresh' },
                  ],
                },
              });
            }
          })().then(() => sendResponse(true));
          return true;
        }
        case 'start-macro-recording': {
          void sendToContent(message.tabId, { type: 'enter-recording-mode' }).then(() => sendResponse(true));
          return true;
        }
        case 'stop-macro-recording': {
          void sendToContent(message.tabId, { type: 'exit-recording-mode' }).then(() => sendResponse(true));
          return true;
        }
        case 'macro-step-recorded': {
          // Broadcast-only message: content script -> popup. The background
          // worker has nothing to persist here (popup saves on Stop & Save).
          return false;
        }
        default:
          return false;
      }
    },
  );
});
