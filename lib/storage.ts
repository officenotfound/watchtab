import { browser } from 'wxt/browser';
import {
  createDefaultMonitorState,
  createDefaultSiteConditionsState,
  DEFAULT_AUTOMATION_CONFIG,
  DEFAULT_MACRO_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_SITE_CONDITIONS_CONFIG,
  type TabWatchState,
} from './types';

const KEY_PREFIX = 'watchtab:tab:';

function keyFor(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

/**
 * Backfills fields added after a record was first persisted (e.g. `monitor`
 * from phase 2) so state saved by an older build of the extension doesn't
 * crash readers that assume the current shape.
 */
function normalize(state: TabWatchState): TabWatchState {
  return {
    ...state,
    monitor: state.monitor ?? { ...DEFAULT_MONITOR_CONFIG },
    monitorState: state.monitorState ?? createDefaultMonitorState(),
    siteConditions: state.siteConditions ?? { ...DEFAULT_SITE_CONDITIONS_CONFIG },
    siteConditionsState: state.siteConditionsState ?? createDefaultSiteConditionsState(),
    automation: state.automation ?? { ...DEFAULT_AUTOMATION_CONFIG, clickTargets: [] },
    cookieRules: state.cookieRules ?? [],
    macro: state.macro ?? { ...DEFAULT_MACRO_CONFIG, steps: [] },
  };
}

export async function getTabState(tabId: number): Promise<TabWatchState | null> {
  const result = await browser.storage.local.get(keyFor(tabId));
  const raw = result[keyFor(tabId)] as TabWatchState | undefined;
  return raw ? normalize(raw) : null;
}

export async function setTabState(state: TabWatchState): Promise<void> {
  await browser.storage.local.set({ [keyFor(state.tabId)]: state });
}

export async function removeTabState(tabId: number): Promise<void> {
  await browser.storage.local.remove(keyFor(tabId));
}

export async function getAllTabStates(): Promise<TabWatchState[]> {
  const all = await browser.storage.local.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(KEY_PREFIX))
    .map(([, value]) => normalize(value as TabWatchState));
}
