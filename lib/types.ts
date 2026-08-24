export type IntervalMode = 'fixed' | 'random' | 'custom';

export interface IntervalConfig {
  mode: IntervalMode;
  /** Fixed mode: seconds between refreshes. */
  fixedSeconds: number;
  /** Random mode: inclusive bounds in seconds. */
  randomMinSeconds: number;
  randomMaxSeconds: number;
  /** Custom mode: duration expressed as h/m/s and summed to seconds. */
  customHours: number;
  customMinutes: number;
  customSeconds: number;
}

export interface TabWatchState {
  tabId: number;
  active: boolean;
  paused: boolean;
  interval: IntervalConfig;
  hardRefresh: boolean;
  refreshLimit: number | null;
  refreshCount: number;
  pauseOnInteraction: boolean;
  showCountdown: boolean;
  /** Epoch ms when the next refresh is scheduled to fire. */
  nextRefreshAt: number | null;
}

export const DEFAULT_INTERVAL: IntervalConfig = {
  mode: 'fixed',
  fixedSeconds: 30,
  randomMinSeconds: 10,
  randomMaxSeconds: 60,
  customHours: 0,
  customMinutes: 1,
  customSeconds: 0,
};

export function createDefaultState(tabId: number): TabWatchState {
  return {
    tabId,
    active: false,
    paused: false,
    interval: { ...DEFAULT_INTERVAL },
    hardRefresh: false,
    refreshLimit: null,
    refreshCount: 0,
    pauseOnInteraction: false,
    showCountdown: false,
    nextRefreshAt: null,
  };
}

export function resolveIntervalSeconds(interval: IntervalConfig): number {
  switch (interval.mode) {
    case 'fixed':
      return Math.max(1, interval.fixedSeconds);
    case 'random': {
      const min = Math.max(1, Math.min(interval.randomMinSeconds, interval.randomMaxSeconds));
      const max = Math.max(min, interval.randomMaxSeconds);
      return Math.round(min + Math.random() * (max - min));
    }
    case 'custom':
      return Math.max(
        1,
        interval.customHours * 3600 + interval.customMinutes * 60 + interval.customSeconds,
      );
    default:
      return 30;
  }
}

/** Messages sent from the popup or content script to the background worker. */
export type RuntimeMessage =
  | { type: 'user-interaction' }
  | { type: 'get-my-state' }
  | { type: 'get-state'; tabId: number }
  | { type: 'start'; tabId: number; settings: TabSettings }
  | { type: 'stop'; tabId: number }
  | { type: 'update-settings'; tabId: number; settings: TabSettings }
  | { type: 'resume'; tabId: number };

export type TabSettings = Pick<
  TabWatchState,
  'interval' | 'hardRefresh' | 'refreshLimit' | 'pauseOnInteraction' | 'showCountdown'
>;
