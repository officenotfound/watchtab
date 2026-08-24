import { browser } from 'wxt/browser';
import type { TabWatchState } from './types';

const KEY_PREFIX = 'watchtab:tab:';

function keyFor(tabId: number): string {
  return `${KEY_PREFIX}${tabId}`;
}

export async function getTabState(tabId: number): Promise<TabWatchState | null> {
  const result = await browser.storage.local.get(keyFor(tabId));
  return (result[keyFor(tabId)] as TabWatchState | undefined) ?? null;
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
    .map(([, value]) => value as TabWatchState);
}
