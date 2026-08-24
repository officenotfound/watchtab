import { browser } from 'wxt/browser';
import { getAllTabStates, getTabState, removeTabState, setTabState } from '@/lib/storage';
import {
  createDefaultState,
  resolveIntervalSeconds,
  type RuntimeMessage,
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
    setTimeout(() => void handleRefreshDue(tabId), Math.max(0, delayMs)),
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
}

async function pauseWatching(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || state.paused) return;
  clearTimer(tabId);
  await setTabState({ ...state, paused: true, nextRefreshAt: null });
}

async function resumeWatching(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || !state.paused) return;
  await scheduleNext({ ...state, paused: false });
}

async function startWatching(tabId: number, settings: Partial<TabWatchState>): Promise<void> {
  const existing = (await getTabState(tabId)) ?? createDefaultState(tabId);
  const next: TabWatchState = {
    ...existing,
    ...settings,
    tabId,
    active: true,
    paused: false,
    refreshCount: 0,
  };
  await scheduleNext(next);
}

/** Persists settings whether or not the tab is currently refreshing, and reschedules live if it is. */
async function updateSettings(tabId: number, settings: Partial<TabWatchState>): Promise<void> {
  const existing = (await getTabState(tabId)) ?? createDefaultState(tabId);
  const next: TabWatchState = { ...existing, ...settings, tabId };
  await setTabState(next);
  if (next.active && !next.paused) {
    await scheduleNext(next);
  }
}

async function handleRefreshDue(tabId: number): Promise<void> {
  const state = await getTabState(tabId);
  if (!state || !state.active || state.paused) return;

  if (state.refreshLimit !== null && state.refreshCount >= state.refreshLimit) {
    await stopWatching(tabId);
    return;
  }

  try {
    await browser.tabs.reload(tabId, { bypassCache: state.hardRefresh });
  } catch {
    // Tab may have closed between the timer firing and the reload call.
    await removeTabState(tabId);
    clearTimer(tabId);
    return;
  }

  const updated: TabWatchState = { ...state, refreshCount: state.refreshCount + 1 };

  if (updated.refreshLimit !== null && updated.refreshCount >= updated.refreshLimit) {
    await setTabState({ ...updated, active: false, nextRefreshAt: null });
    clearTimer(tabId);
    return;
  }

  await scheduleNext(updated);
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
      void handleRefreshDue(state.tabId);
    } else {
      armTimer(state.tabId, remaining);
    }
  }
}

export default defineBackground(() => {
  browser.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  void recoverActiveTimers();

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

  browser.runtime.onMessage.addListener(
    (message: RuntimeMessage, sender, sendResponse: (response: unknown) => void) => {
      switch (message.type) {
        case 'user-interaction': {
          const tabId = sender.tab?.id;
          if (tabId !== undefined) {
            void pauseWatching(tabId);
          }
          return false;
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
          void startWatching(message.tabId, message.settings).then(() => sendResponse(true));
          return true;
        }
        case 'stop': {
          void stopWatching(message.tabId).then(() => sendResponse(true));
          return true;
        }
        case 'update-settings': {
          void updateSettings(message.tabId, message.settings).then(() => sendResponse(true));
          return true;
        }
        case 'resume': {
          void resumeWatching(message.tabId).then(() => sendResponse(true));
          return true;
        }
        default:
          return false;
      }
    },
  );
});
