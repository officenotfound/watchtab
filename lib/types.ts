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

export type MonitorScopeMode = 'full-page' | 'custom-area';
export type MonitorExtractionMode = 'visual' | 'source';
export type MonitorAlertMode = 'found' | 'lost' | 'any-change';
export type MonitorTriggerKind = 'found' | 'lost' | 'any-change';

export interface MonitorConfig {
  enabled: boolean;
  scopeMode: MonitorScopeMode;
  /** CSS selector scoping the search when scopeMode is 'custom-area'. */
  customSelector: string;
  extractionMode: MonitorExtractionMode;
  /** Raw comma-separated expression input: plain keywords, ##boolean##, @@xpath, $regex. */
  keywords: string;
  alertMode: MonitorAlertMode;
  skipRepeat: boolean;
  waitForLoadMs: number;
  highlight: boolean;
  windowFocus: boolean;
  /** When false (the default), an alert trigger also stops active refreshing on this tab. */
  continueRefreshingAfterAlert: boolean;
}

export interface MonitorRuntimeState {
  lastScanAt: number | null;
  /** Expressions that matched on the most recent scan. */
  matchedKeys: string[];
  /** Whether any expression has ever matched since monitoring started (used by lost-mode). */
  hasEverMatched: boolean;
  currentlyMatching: boolean;
  lastTriggerAt: number | null;
  lastTriggerKind: MonitorTriggerKind | null;
  /** Content hash used by "any changes" mode. */
  lastSnapshotHash: string | null;
  /** Set when a custom-area selector isn't found, or an expression fails to parse. */
  error: string | null;
  /**
   * Tracks whether the auto-click action has already run for the current
   * continuous match. Deliberately independent of the found/lost
   * notification's skip-repeat bookkeeping: monitoring runs continuously as
   * soon as it's enabled (before "Start refreshing" and regardless of when
   * automation toggles get turned on), so a match can transition to "found"
   * — and consume the notification's one-shot trigger — before the user has
   * finished configuring automation. Auto-click's contract is "click while
   * matching," so it needs its own arm/fire state rather than inheriting a
   * trigger that may have already fired for an unrelated reason.
   */
  autoClickFiredForMatch: boolean;
}

export const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  enabled: false,
  scopeMode: 'full-page',
  customSelector: '',
  extractionMode: 'visual',
  keywords: '',
  alertMode: 'found',
  skipRepeat: true,
  waitForLoadMs: 0,
  highlight: true,
  windowFocus: false,
  continueRefreshingAfterAlert: false,
};

export function createDefaultMonitorState(): MonitorRuntimeState {
  return {
    lastScanAt: null,
    matchedKeys: [],
    hasEverMatched: false,
    currentlyMatching: false,
    lastTriggerAt: null,
    lastTriggerKind: null,
    lastSnapshotHash: null,
    error: null,
    autoClickFiredForMatch: false,
  };
}

export type RedirectBehavior = 'follow-all' | 'follow-canonical';
export type SiteConditionKind = 'captcha' | 'error' | 'redirect';

export interface SiteConditionsConfig {
  captchaDetection: boolean;
  captchaSound: boolean;
  errorDetection: boolean;
  errorSound: boolean;
  redirectBehavior: RedirectBehavior;
  /** Tab's URL captured when refreshing started; used by 'follow-canonical' to detect a redirect away from it. */
  originUrl: string | null;
}

export interface SiteConditionsRuntimeState {
  lastDetectionAt: number | null;
  lastDetectionKind: SiteConditionKind | null;
  captchaDetected: boolean;
  errorDetected: boolean;
  /** HTTP status observed for the most recent main-frame navigation, if known. */
  lastStatusCode: number | null;
  redirected: boolean;
}

export const DEFAULT_SITE_CONDITIONS_CONFIG: SiteConditionsConfig = {
  captchaDetection: false,
  captchaSound: false,
  errorDetection: false,
  errorSound: false,
  redirectBehavior: 'follow-all',
  originUrl: null,
};

export function createDefaultSiteConditionsState(): SiteConditionsRuntimeState {
  return {
    lastDetectionAt: null,
    lastDetectionKind: null,
    captchaDetected: false,
    errorDetected: false,
    lastStatusCode: null,
    redirected: false,
  };
}

/** Shared trigger vocabulary for automation features (click targets, macros). */
export type AutomationTrigger = 'each-refresh' | 'when-alert-triggers';

export type PickerTarget = 'custom-area' | 'click-target';

export interface ClickTarget {
  id: string;
  selector: string;
  trigger: AutomationTrigger;
}

export interface AutomationConfig {
  autoClickKeyword: boolean;
  autoClickOpenNewTab: boolean;
  clickTargets: ClickTarget[];
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  autoClickKeyword: false,
  autoClickOpenNewTab: false,
  clickTargets: [],
};

export type CookieRuleAction = 'set' | 'delete';
export type CookieRuleTiming = 'before-refresh' | 'after-refresh';

export interface CookieRule {
  id: string;
  name: string;
  value: string;
  action: CookieRuleAction;
  timing: CookieRuleTiming;
}

export type MacroStep =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'select'; selector: string; value: string }
  | { type: 'keypress'; key: string; selector?: string }
  | { type: 'wait'; durationMs: number }
  | { type: 'navigate'; url: string }
  | { type: 'scroll'; target: 'top' | 'bottom' | string };

export interface MacroConfig {
  enabled: boolean;
  trigger: AutomationTrigger;
  steps: MacroStep[];
}

export const DEFAULT_MACRO_CONFIG: MacroConfig = {
  enabled: false,
  trigger: 'each-refresh',
  steps: [],
};

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
  monitor: MonitorConfig;
  monitorState: MonitorRuntimeState;
  siteConditions: SiteConditionsConfig;
  siteConditionsState: SiteConditionsRuntimeState;
  automation: AutomationConfig;
  cookieRules: CookieRule[];
  macro: MacroConfig;
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
    monitor: { ...DEFAULT_MONITOR_CONFIG },
    monitorState: createDefaultMonitorState(),
    siteConditions: { ...DEFAULT_SITE_CONDITIONS_CONFIG },
    siteConditionsState: createDefaultSiteConditionsState(),
    automation: { ...DEFAULT_AUTOMATION_CONFIG, clickTargets: [] },
    cookieRules: [],
    macro: { ...DEFAULT_MACRO_CONFIG, steps: [] },
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
  | { type: 'get-appearance' }
  | { type: 'set-appearance'; settings: import('./appearance').AppearanceSettings }
  | { type: 'get-state'; tabId: number }
  | { type: 'start'; tabId: number; settings: TabSettings }
  | { type: 'stop'; tabId: number }
  | { type: 'update-settings'; tabId: number; settings: TabSettings }
  | { type: 'resume'; tabId: number }
  | {
      type: 'monitor-scan';
      monitorState: MonitorRuntimeState;
      triggered: boolean;
      triggerKind: MonitorTriggerKind | null;
      /**
       * Whether refreshing should be stopped right now, computed fresh every
       * scan rather than tied to the (skip-repeat, one-shot) notification
       * trigger above. Monitoring runs continuously as soon as it's enabled,
       * before "Start refreshing" is ever clicked — so a found/lost edge can
       * fire, and get consumed by skip-repeat, while the tab isn't refreshing
       * yet. If "stop on alert" only reacted to that same one-shot edge, it
       * would silently never fire once refreshing actually starts. This flag
       * is idempotent for found/lost ("currently matching" / "currently
       * lost" is just re-asserted every scan); any-change still rides the
       * trigger above since it has no persistent level to re-check.
       */
      stopRefreshRequested: boolean;
    }
  | { type: 'start-picker'; tabId: number; target: PickerTarget }
  | { type: 'cancel-picker'; tabId: number }
  | { type: 'picker-result'; selector: string; target: PickerTarget }
  | { type: 'site-condition-scan'; captchaDetected: boolean; errorDetected: boolean }
  | { type: 'start-macro-recording'; tabId: number }
  | { type: 'stop-macro-recording'; tabId: number }
  | { type: 'macro-step-recorded'; step: MacroStep };

/** Sent directly from the background worker to a tab's content script (not through RuntimeMessage's popup/content dispatch). */
export type ContentCommand =
  | { type: 'enter-picker-mode'; target: PickerTarget }
  | { type: 'exit-picker-mode' }
  | { type: 'enter-recording-mode' }
  | { type: 'exit-recording-mode' };

export type TabSettings = Pick<
  TabWatchState,
  | 'interval'
  | 'hardRefresh'
  | 'refreshLimit'
  | 'pauseOnInteraction'
  | 'showCountdown'
  | 'monitor'
  | 'siteConditions'
  | 'automation'
  | 'cookieRules'
  | 'macro'
>;
