import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { browser } from 'wxt/browser';
import {
  createDefaultState,
  resolveIntervalSeconds,
  type AutomationConfig,
  type AutomationTrigger,
  type ClickTarget,
  type CookieRule,
  type IntervalMode,
  type MacroConfig,
  type MacroStep,
  type MonitorAlertMode,
  type MonitorConfig,
  type RedirectBehavior,
  type SiteConditionsConfig,
  type TabWatchState,
} from '@/lib/types';
import { EXPRESSION_TEMPLATES } from '@/lib/templates';
import {
  ACCENT_COLOR_VALUES,
  DEFAULT_APPEARANCE_SETTINGS,
  type AccentColor,
  type AppearanceSettings,
} from '@/lib/appearance';
import './App.css';

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
}

const TRIGGER_LABELS: [AutomationTrigger, string][] = [
  ['each-refresh', 'Each refresh'],
  ['when-alert-triggers', 'When alert triggers'],
];

const FIXED_PRESETS = [5, 10, 15, 30, 60, 300];

function formatPreset(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
}

type PopupTab = 'refresh' | 'monitor' | 'automation' | 'conditions' | 'settings';

const POPUP_TABS: [PopupTab, string][] = [
  ['refresh', 'Refresh'],
  ['monitor', 'Monitor'],
  ['automation', 'Automation'],
  ['conditions', 'Conditions'],
  ['settings', 'Settings'],
];

const ACCENT_COLORS: AccentColor[] = ['blue', 'purple', 'green', 'orange', 'pink'];

/** Resolves whichever half of an accent pair (light/dark) is active right now, for the CSS var override. */
function resolveAccentPair(color: AccentColor): { accent: string; accentStrong: string } {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const pair = ACCENT_COLOR_VALUES[color];
  return prefersDark
    ? { accent: pair.dark, accentStrong: pair.light }
    : { accent: pair.light, accentStrong: pair.dark };
}

function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabTitle, setTabTitle] = useState('');
  const [activeTab, setActiveTab] = useState<PopupTab>('refresh');
  const [state, setState] = useState<TabWatchState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isRecording, setIsRecording] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<MacroStep[]>([]);
  const [macroJsonText, setMacroJsonText] = useState('');
  const [macroJsonError, setMacroJsonError] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>(DEFAULT_APPEARANCE_SETTINGS);

  useEffect(() => {
    function handler(message: unknown) {
      const msg = message as { type?: string; step?: MacroStep };
      if (msg?.type === 'macro-step-recorded' && msg.step) {
        setRecordedSteps((prev) => [...prev, msg.step as MacroStep]);
      }
    }
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (cancelled || !tab?.id) return;
      setTabId(tab.id);
      setTabTitle(tab.title ?? tab.url ?? '');
      const existing = (await browser.runtime.sendMessage({ type: 'get-state', tabId: tab.id })) as
        | TabWatchState
        | null;
      if (!cancelled) {
        setState(existing ?? createDefaultState(tab.id));
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Independent of the per-tab state fetch above — global appearance has
    // no relationship to tabId, so it's fetched in parallel and applied
    // whenever it resolves rather than gating the per-tab init.
    let cancelled = false;
    (async () => {
      const existing = (await browser.runtime.sendMessage({ type: 'get-appearance' })) as AppearanceSettings | null;
      if (!cancelled && existing) setAppearance({ ...DEFAULT_APPEARANCE_SETTINGS, ...existing });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function applyAppearance(partial: Partial<AppearanceSettings>) {
    const next = { ...appearance, ...partial };
    setAppearance(next);
    await browser.runtime.sendMessage({ type: 'set-appearance', settings: next });
  }

  const accentPair = useMemo(() => resolveAccentPair(appearance.accentColor), [appearance.accentColor]);
  const rootStyle = {
    '--glass-opacity': appearance.glassOpacity,
    '--accent': accentPair.accent,
    '--accent-strong': accentPair.accentStrong,
    '--transition-duration': appearance.reduceMotion ? '0s' : '0.15s',
  } as CSSProperties;

  useEffect(() => {
    if (!tabId) return;
    const poll = window.setInterval(async () => {
      const fresh = (await browser.runtime
        .sendMessage({ type: 'get-state', tabId })
        .catch(() => null)) as TabWatchState | null;
      if (fresh) setState(fresh);
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(poll);
  }, [tabId]);

  const nextRefreshSeconds = useMemo(() => {
    if (!state?.nextRefreshAt) return null;
    return Math.max(0, Math.ceil((state.nextRefreshAt - now) / 1000));
  }, [state?.nextRefreshAt, now]);

  if (!state || !tabId) {
    return (
      <div className="app" style={rootStyle}>
        <p className="tabUrl">Loading tab…</p>
      </div>
    );
  }

  async function applyLiveSettings(partial: Partial<TabWatchState>) {
    if (!state || !tabId) return;
    const next = { ...state, ...partial };
    setState(next);
    // Persisted regardless of active state, so a choice made before Start
    // survives the popup's own 1s state poll instead of being overwritten
    // by the still-default value in storage.
    await browser.runtime.sendMessage({
      type: 'update-settings',
      tabId,
      settings: {
        interval: next.interval,
        hardRefresh: next.hardRefresh,
        refreshLimit: next.refreshLimit,
        pauseOnInteraction: next.pauseOnInteraction,
        showCountdown: next.showCountdown,
        monitor: next.monitor,
        siteConditions: next.siteConditions,
        automation: next.automation,
        cookieRules: next.cookieRules,
        macro: next.macro,
      },
    });
  }

  async function applyMonitor(partial: Partial<MonitorConfig>) {
    if (!state) return;
    await applyLiveSettings({ monitor: { ...state.monitor, ...partial } });
  }

  async function applySiteConditions(partial: Partial<SiteConditionsConfig>) {
    if (!state) return;
    await applyLiveSettings({ siteConditions: { ...state.siteConditions, ...partial } });
  }

  async function applyAutomation(partial: Partial<AutomationConfig>) {
    if (!state) return;
    await applyLiveSettings({ automation: { ...state.automation, ...partial } });
  }

  async function applyMacro(partial: Partial<MacroConfig>) {
    if (!state) return;
    await applyLiveSettings({ macro: { ...state.macro, ...partial } });
  }

  async function applyCookieRulesList(rules: CookieRule[]) {
    if (!state) return;
    await applyLiveSettings({ cookieRules: rules });
  }

  function applyTemplate(expression: string) {
    if (!state) return;
    const current = state.monitor.keywords.trim();
    const next = current ? `${current}, ${expression}` : expression;
    void applyMonitor({ keywords: next });
  }

  async function pickElement() {
    if (!tabId) return;
    await browser.runtime.sendMessage({ type: 'start-picker', tabId, target: 'custom-area' });
  }

  async function pickClickTarget() {
    if (!tabId) return;
    await browser.runtime.sendMessage({ type: 'start-picker', tabId, target: 'click-target' });
  }

  function updateClickTarget(id: string, partial: Partial<ClickTarget>) {
    if (!state) return;
    const next = state.automation.clickTargets.map((t) => (t.id === id ? { ...t, ...partial } : t));
    void applyAutomation({ clickTargets: next });
  }

  function removeClickTarget(id: string) {
    if (!state) return;
    void applyAutomation({ clickTargets: state.automation.clickTargets.filter((t) => t.id !== id) });
  }

  function addClickTarget() {
    if (!state) return;
    const next: ClickTarget = { id: newId('click'), selector: '', trigger: 'each-refresh' };
    void applyAutomation({ clickTargets: [...state.automation.clickTargets, next] });
  }

  function updateCookieRule(id: string, partial: Partial<CookieRule>) {
    if (!state) return;
    void applyCookieRulesList(state.cookieRules.map((r) => (r.id === id ? { ...r, ...partial } : r)));
  }

  function removeCookieRule(id: string) {
    if (!state) return;
    void applyCookieRulesList(state.cookieRules.filter((r) => r.id !== id));
  }

  function addCookieRule() {
    if (!state) return;
    const next: CookieRule = { id: newId('cookie'), name: '', value: '', action: 'set', timing: 'before-refresh' };
    void applyCookieRulesList([...state.cookieRules, next]);
  }

  function moveMacroStep(index: number, direction: -1 | 1) {
    if (!state) return;
    const steps = [...state.macro.steps];
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const tmp = steps[index]!;
    steps[index] = steps[target]!;
    steps[target] = tmp;
    void applyMacro({ steps });
  }

  function removeMacroStep(index: number) {
    if (!state) return;
    void applyMacro({ steps: state.macro.steps.filter((_, i) => i !== index) });
  }

  async function startRecording() {
    if (!tabId) return;
    setRecordedSteps([]);
    setIsRecording(true);
    await browser.runtime.sendMessage({ type: 'start-macro-recording', tabId });
  }

  async function stopAndSaveRecording() {
    if (!tabId) return;
    await browser.runtime.sendMessage({ type: 'stop-macro-recording', tabId });
    setIsRecording(false);
    await applyMacro({ steps: recordedSteps });
  }

  function loadStepsIntoEditor() {
    if (!state) return;
    setMacroJsonText(JSON.stringify(state.macro.steps, null, 2));
    setMacroJsonError(null);
  }

  function saveStepsFromEditor() {
    try {
      const parsed = JSON.parse(macroJsonText);
      if (!Array.isArray(parsed)) throw new Error('Steps must be a JSON array');
      setMacroJsonError(null);
      void applyMacro({ steps: parsed as MacroStep[] });
    } catch (err) {
      setMacroJsonError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  }

  async function handleStartStop() {
    if (!tabId || !state) return;
    if (state.active) {
      await browser.runtime.sendMessage({ type: 'stop', tabId });
      setState({ ...state, active: false, paused: false, nextRefreshAt: null });
    } else {
      await browser.runtime.sendMessage({
        type: 'start',
        tabId,
        settings: {
          interval: state.interval,
          hardRefresh: state.hardRefresh,
          refreshLimit: state.refreshLimit,
          pauseOnInteraction: state.pauseOnInteraction,
          showCountdown: state.showCountdown,
          monitor: state.monitor,
          siteConditions: state.siteConditions,
          automation: state.automation,
          cookieRules: state.cookieRules,
          macro: state.macro,
        },
      });
      setState({ ...state, active: true, paused: false, refreshCount: 0 });
    }
  }

  function setMode(mode: IntervalMode) {
    void applyLiveSettings({ interval: { ...state!.interval, mode } });
  }

  function setFixedSeconds(seconds: number) {
    void applyLiveSettings({
      interval: { ...state!.interval, mode: 'fixed', fixedSeconds: seconds },
    });
  }

  const previewSeconds = resolveIntervalSeconds(state.interval);

  return (
    <div className="app" style={rootStyle}>
      <div className="header">
        <svg className="brandMark" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="watchtab">
          <path
            d="M10 3.5a6.5 6.5 0 1 1-6.5 6.5"
            stroke="var(--accent)"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
          <path d="M3.5 5.8V10h4.2" stroke="var(--accent)" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="tabUrl" title={tabTitle}>
          {tabTitle}
        </p>
      </div>

      <div className="modeRow tabRow">
        {POPUP_TABS.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            className={`modeButton${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'refresh' && (
      <>
      <div className="status">
        <span className="statusText">
          {state.active ? (
            state.paused ? (
              <>Paused</>
            ) : (
              <>
                Refreshing every <strong>{formatPreset(previewSeconds)}</strong> · {state.refreshCount}{' '}
                {state.refreshCount === 1 ? 'refresh' : 'refreshes'} so far
              </>
            )
          ) : (
            <>Stopped</>
          )}
        </span>
        {state.active && !state.paused && nextRefreshSeconds !== null && (
          <span className="countdown">{nextRefreshSeconds}s</span>
        )}
      </div>

      <div className="section">
        <p className="sectionLabel">Interval</p>
        <div className="modeRow">
          {(['fixed', 'random', 'custom'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`modeButton${state.interval.mode === mode ? ' active' : ''}`}
              onClick={() => setMode(mode)}
            >
              {mode === 'fixed' ? 'Fixed' : mode === 'random' ? 'Random' : 'Custom'}
            </button>
          ))}
        </div>

        {state.interval.mode === 'fixed' && (
          <div className="chipRow">
            {FIXED_PRESETS.map((seconds) => (
              <button
                key={seconds}
                type="button"
                className={`chip${state.interval.fixedSeconds === seconds ? ' active' : ''}`}
                onClick={() => setFixedSeconds(seconds)}
              >
                {formatPreset(seconds)}
              </button>
            ))}
          </div>
        )}

        {state.interval.mode === 'random' && (
          <>
            <div className="fieldRow">
              <label htmlFor="random-min">Min (s)</label>
              <input
                id="random-min"
                className="numberInput"
                type="number"
                min={1}
                value={state.interval.randomMinSeconds}
                onChange={(e) =>
                  void applyLiveSettings({
                    interval: { ...state.interval, randomMinSeconds: Number(e.target.value) || 1 },
                  })
                }
              />
            </div>
            <div className="fieldRow">
              <label htmlFor="random-max">Max (s)</label>
              <input
                id="random-max"
                className="numberInput"
                type="number"
                min={1}
                value={state.interval.randomMaxSeconds}
                onChange={(e) =>
                  void applyLiveSettings({
                    interval: { ...state.interval, randomMaxSeconds: Number(e.target.value) || 1 },
                  })
                }
              />
            </div>
          </>
        )}

        {state.interval.mode === 'custom' && (
          <div className="durationRow">
            <input
              className="durationInput"
              type="number"
              min={0}
              value={state.interval.customHours}
              onChange={(e) =>
                void applyLiveSettings({
                  interval: { ...state.interval, customHours: Number(e.target.value) || 0 },
                })
              }
            />
            <span className="durationUnit">h</span>
            <input
              className="durationInput"
              type="number"
              min={0}
              value={state.interval.customMinutes}
              onChange={(e) =>
                void applyLiveSettings({
                  interval: { ...state.interval, customMinutes: Number(e.target.value) || 0 },
                })
              }
            />
            <span className="durationUnit">m</span>
            <input
              className="durationInput"
              type="number"
              min={0}
              value={state.interval.customSeconds}
              onChange={(e) =>
                void applyLiveSettings({
                  interval: { ...state.interval, customSeconds: Number(e.target.value) || 0 },
                })
              }
            />
            <span className="durationUnit">s</span>
          </div>
        )}
      </div>

      <div className="section">
        <p className="sectionLabel">Limits</p>
        <div className="fieldRow">
          <label htmlFor="refresh-limit">Stop after</label>
          <input
            id="refresh-limit"
            className="numberInput"
            type="number"
            min={1}
            placeholder="unlimited"
            value={state.refreshLimit ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              void applyLiveSettings({ refreshLimit: raw === '' ? null : Math.max(1, Number(raw)) });
            }}
          />
        </div>
      </div>

      <div className="section">
        <div className="toggleRow">
          <span className="toggleLabel">
            Hard refresh
            <span className="toggleHint">Bypass the browser cache</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.hardRefresh}
            onChange={(e) => void applyLiveSettings({ hardRefresh: e.target.checked })}
          />
        </div>
        <div className="toggleRow">
          <span className="toggleLabel">
            Pause on interaction
            <span className="toggleHint">Stop the timer if you click, type, or scroll</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.pauseOnInteraction}
            onChange={(e) => void applyLiveSettings({ pauseOnInteraction: e.target.checked })}
          />
        </div>
        <div className="toggleRow">
          <span className="toggleLabel">
            On-page countdown
            <span className="toggleHint">Show seconds remaining in the corner of the page</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.showCountdown}
            onChange={(e) => void applyLiveSettings({ showCountdown: e.target.checked })}
          />
        </div>
      </div>
      </>
      )}

      {activeTab === 'monitor' && (
      <>
      <div className="section">
        <div className="toggleRow">
          <span className="toggleLabel">
            Monitor page for changes
            <span className="toggleHint">Watch for keywords, or any change in the page content</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.monitor.enabled}
            onChange={(e) => void applyMonitor({ enabled: e.target.checked })}
          />
        </div>

        {state.monitor.enabled && (
          <>
            <div className="modeRow">
              <button
                type="button"
                className={`modeButton${state.monitor.scopeMode === 'full-page' ? ' active' : ''}`}
                onClick={() => void applyMonitor({ scopeMode: 'full-page' })}
              >
                Full page
              </button>
              <button
                type="button"
                className={`modeButton${state.monitor.scopeMode === 'custom-area' ? ' active' : ''}`}
                onClick={() => void applyMonitor({ scopeMode: 'custom-area' })}
              >
                Custom area
              </button>
            </div>

            {state.monitor.scopeMode === 'custom-area' && (
              <div className="fieldRow">
                <input
                  className="numberInput"
                  style={{ width: 'auto', flex: 1 }}
                  type="text"
                  placeholder="CSS selector"
                  value={state.monitor.customSelector}
                  onChange={(e) => void applyMonitor({ customSelector: e.target.value })}
                />
                <button type="button" className="chip" onClick={() => void pickElement()}>
                  Pick element
                </button>
              </div>
            )}

            <div className="fieldRow">
              <label htmlFor="monitor-keywords">Keywords</label>
            </div>
            <textarea
              id="monitor-keywords"
              className="numberInput"
              style={{ width: '100%', minHeight: '44px', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}
              placeholder="Enter keyword, regex, XPath, or CSS selector (separate multiple with commas)…"
              value={state.monitor.keywords}
              onChange={(e) => void applyMonitor({ keywords: e.target.value })}
            />
            <p className="toggleHint">
              plain word = keyword · ##(a OR b) AND c## = boolean · @@//div = XPath · $foo/i = regex
            </p>
            <div className="fieldRow">
              <label>Templates</label>
            </div>
            <div className="chipRow">
              {EXPRESSION_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="chip"
                  title={tpl.expression}
                  onClick={() => applyTemplate(tpl.expression)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>

            <div className="modeRow">
              <button
                type="button"
                className={`modeButton${state.monitor.extractionMode === 'visual' ? ' active' : ''}`}
                onClick={() => void applyMonitor({ extractionMode: 'visual' })}
              >
                Visual text
              </button>
              <button
                type="button"
                className={`modeButton${state.monitor.extractionMode === 'source' ? ' active' : ''}`}
                onClick={() => void applyMonitor({ extractionMode: 'source' })}
              >
                Page source
              </button>
            </div>

            <div className="modeRow">
              {(
                [
                  ['found', 'Keyword found'],
                  ['lost', 'Keyword lost'],
                  ['any-change', 'Any change'],
                ] as [MonitorAlertMode, string][]
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`modeButton${state.monitor.alertMode === mode ? ' active' : ''}`}
                  onClick={() => void applyMonitor({ alertMode: mode })}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="toggleRow">
              <span className="toggleLabel">
                Skip repeated keyword
                <span className="toggleHint">Only alert once until the match changes</span>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={state.monitor.skipRepeat}
                onChange={(e) => void applyMonitor({ skipRepeat: e.target.checked })}
              />
            </div>
            <div className="toggleRow">
              <span className="toggleLabel">
                Highlight keyword on page
                <span className="toggleHint">Mark matched text in yellow</span>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={state.monitor.highlight}
                onChange={(e) => void applyMonitor({ highlight: e.target.checked })}
              />
            </div>
            <div className="toggleRow">
              <span className="toggleLabel">
                Window focus on detection
                <span className="toggleHint">Bring this tab to the front when triggered</span>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={state.monitor.windowFocus}
                onChange={(e) => void applyMonitor({ windowFocus: e.target.checked })}
              />
            </div>
            <div className="toggleRow">
              <span className="toggleLabel">
                Continue refreshing after alert
                <span className="toggleHint">Off stops the refresh timer once triggered</span>
              </span>
              <input
                type="checkbox"
                className="switch"
                checked={state.monitor.continueRefreshingAfterAlert}
                onChange={(e) =>
                  void applyMonitor({ continueRefreshingAfterAlert: e.target.checked })
                }
              />
            </div>
            <div className="fieldRow">
              <label htmlFor="monitor-wait">Wait for load</label>
              <input
                id="monitor-wait"
                className="numberInput"
                type="number"
                min={0}
                step={250}
                value={state.monitor.waitForLoadMs}
                onChange={(e) =>
                  void applyMonitor({ waitForLoadMs: Math.max(0, Number(e.target.value) || 0) })
                }
              />
              <span className="durationUnit">ms</span>
            </div>

            <div className="status" style={{ marginTop: '8px' }}>
              <span className="statusText">
                {state.monitorState.error ? (
                  <>Monitor error — {state.monitorState.error}</>
                ) : state.monitorState.lastScanAt ? (
                  <>
                    Monitoring active · last scan{' '}
                    {Math.max(0, Math.round((now - state.monitorState.lastScanAt) / 1000))}s ago ·{' '}
                    <strong>{state.monitorState.currentlyMatching ? 'matching' : 'not matching'}</strong>
                  </>
                ) : (
                  <>Monitoring active · waiting for first scan</>
                )}
              </span>
            </div>
          </>
        )}
      </div>
      </>
      )}

      {activeTab === 'conditions' && (
      <>
      <div className="section">
        <p className="sectionLabel">Site conditions</p>
        <div className="toggleRow">
          <span className="toggleLabel">
            Detect Captcha on Page
            <span className="toggleHint">Looks for common captcha widgets; won't catch every kind</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.siteConditions.captchaDetection}
            onChange={(e) => void applySiteConditions({ captchaDetection: e.target.checked })}
          />
        </div>
        {state.siteConditions.captchaDetection && (
          <div className="toggleRow">
            <span className="toggleLabel">
              Play Alarm on Captcha Detection
              <span className="toggleHint">Sound an alert tone in addition to the notification</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={state.siteConditions.captchaSound}
              onChange={(e) => void applySiteConditions({ captchaSound: e.target.checked })}
            />
          </div>
        )}

        <div className="toggleRow">
          <span className="toggleLabel">
            Detect Error Pages (e.g. 404)
            <span className="toggleHint">Flag 4xx/5xx responses and common broken-page text</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.siteConditions.errorDetection}
            onChange={(e) => void applySiteConditions({ errorDetection: e.target.checked })}
          />
        </div>
        {state.siteConditions.errorDetection && (
          <div className="toggleRow">
            <span className="toggleLabel">
              Play Alarm on Error Detection
              <span className="toggleHint">Sound an alert tone in addition to the notification</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={state.siteConditions.errorSound}
              onChange={(e) => void applySiteConditions({ errorSound: e.target.checked })}
            />
          </div>
        )}

        <div className="fieldRow">
          <label>Redirection behavior</label>
        </div>
        <div className="modeRow">
          {(
            [
              ['follow-all', 'Follow All Redirects'],
              ['follow-canonical', 'Follow Canonical URL'],
            ] as [RedirectBehavior, string][]
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`modeButton${state.siteConditions.redirectBehavior === mode ? ' active' : ''}`}
              onClick={() => void applySiteConditions({ redirectBehavior: mode })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="toggleHint">
          Canonical mode stops refreshing and notifies you if the page navigates away from the URL
          refreshing started on.
        </p>

        {(state.siteConditions.captchaDetection || state.siteConditions.errorDetection) && (
          <div className="status" style={{ marginTop: '8px' }}>
            <span className="statusText">
              {state.siteConditionsState.captchaDetected && state.siteConditions.captchaDetection ? (
                <>Captcha detected on page</>
              ) : state.siteConditionsState.errorDetected && state.siteConditions.errorDetection ? (
                <>
                  Error page detected
                  {state.siteConditionsState.lastStatusCode
                    ? ` (status ${state.siteConditionsState.lastStatusCode})`
                    : ''}
                </>
              ) : (
                <>No captcha or error detected</>
              )}
            </span>
          </div>
        )}
        {state.siteConditionsState.redirected && (
          <div className="status" style={{ marginTop: '8px' }}>
            <span className="statusText">Refresh stopped — page redirected from its original URL.</span>
          </div>
        )}
      </div>
      </>
      )}

      {activeTab === 'automation' && (
      <>
      <div className="section">
        <p className="sectionLabel">Automation</p>
        <div className="toggleRow">
          <span className="toggleLabel">
            Auto-click keyword link
            <span className="toggleHint">If a matched keyword is an (or inside an) &lt;a&gt; link, click it</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.automation.autoClickKeyword}
            onChange={(e) => void applyAutomation({ autoClickKeyword: e.target.checked })}
          />
        </div>
        {state.automation.autoClickKeyword && (
          <div className="toggleRow">
            <span className="toggleLabel">
              Open in new tab
              <span className="toggleHint">Instead of clicking in place</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={state.automation.autoClickOpenNewTab}
              onChange={(e) => void applyAutomation({ autoClickOpenNewTab: e.target.checked })}
            />
          </div>
        )}

        <div className="fieldRow">
          <label>Click additional elements</label>
        </div>
        {state.automation.clickTargets.map((target) => (
          <div className="fieldRow" key={target.id}>
            <input
              className="numberInput"
              style={{ width: 'auto', flex: 1 }}
              type="text"
              placeholder="CSS selector"
              value={target.selector}
              onChange={(e) => updateClickTarget(target.id, { selector: e.target.value })}
            />
            <select
              className="numberInput"
              style={{ width: 'auto' }}
              value={target.trigger}
              onChange={(e) => updateClickTarget(target.id, { trigger: e.target.value as AutomationTrigger })}
            >
              {TRIGGER_LABELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="button" className="chip" onClick={() => removeClickTarget(target.id)}>
              Remove
            </button>
          </div>
        ))}
        <div className="chipRow">
          <button type="button" className="chip" onClick={() => void pickClickTarget()}>
            Pick target element
          </button>
          <button type="button" className="chip" onClick={addClickTarget}>
            Add manually
          </button>
        </div>
      </div>

      <div className="section">
        <p className="sectionLabel">Cookie automation</p>
        {state.cookieRules.map((rule) => (
          <div className="fieldRow" key={rule.id}>
            <input
              className="numberInput"
              style={{ width: 'auto', flex: 1 }}
              type="text"
              placeholder="cookie name"
              value={rule.name}
              onChange={(e) => updateCookieRule(rule.id, { name: e.target.value })}
            />
            <input
              className="numberInput"
              style={{ width: 'auto', flex: 1 }}
              type="text"
              placeholder="value"
              value={rule.value}
              onChange={(e) => updateCookieRule(rule.id, { value: e.target.value })}
              disabled={rule.action === 'delete'}
            />
            <select
              className="numberInput"
              style={{ width: 'auto' }}
              value={rule.action}
              onChange={(e) => updateCookieRule(rule.id, { action: e.target.value as CookieRule['action'] })}
            >
              <option value="set">Set</option>
              <option value="delete">Delete</option>
            </select>
            <select
              className="numberInput"
              style={{ width: 'auto' }}
              value={rule.timing}
              onChange={(e) => updateCookieRule(rule.id, { timing: e.target.value as CookieRule['timing'] })}
            >
              <option value="before-refresh">Before refresh</option>
              <option value="after-refresh">After refresh</option>
            </select>
            <button type="button" className="chip" onClick={() => removeCookieRule(rule.id)}>
              Remove
            </button>
          </div>
        ))}
        <div className="chipRow">
          <button type="button" className="chip" onClick={addCookieRule}>
            Add cookie rule
          </button>
        </div>
      </div>

      <div className="section">
        <p className="sectionLabel">Macros</p>
        <div className="toggleRow">
          <span className="toggleLabel">
            Run macro
            <span className="toggleHint">Play back a recorded sequence of actions</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={state.macro.enabled}
            onChange={(e) => void applyMacro({ enabled: e.target.checked })}
          />
        </div>

        {state.macro.enabled && (
          <>
            <div className="modeRow">
              {TRIGGER_LABELS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`modeButton${state.macro.trigger === value ? ' active' : ''}`}
                  onClick={() => void applyMacro({ trigger: value })}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="fieldRow">
              <label>Steps</label>
            </div>
            {state.macro.steps.map((step, i) => (
              <div className="fieldRow" key={i}>
                <span className="toggleHint" style={{ flex: 1 }}>
                  {i + 1}. {step.type}
                  {'selector' in step ? ` — ${step.selector}` : ''}
                  {'value' in step ? ` = ${step.value}` : ''}
                  {step.type === 'wait' ? ` — ${step.durationMs}ms` : ''}
                  {step.type === 'navigate' ? ` — ${step.url}` : ''}
                  {step.type === 'scroll' ? ` — ${step.target}` : ''}
                  {step.type === 'keypress' ? ` — ${step.key}` : ''}
                </span>
                <button type="button" className="chip" onClick={() => moveMacroStep(i, -1)} disabled={i === 0}>
                  Up
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => moveMacroStep(i, 1)}
                  disabled={i === state.macro.steps.length - 1}
                >
                  Down
                </button>
                <button type="button" className="chip" onClick={() => removeMacroStep(i)}>
                  Remove
                </button>
              </div>
            ))}

            <div className="chipRow">
              {!isRecording ? (
                <button type="button" className="chip" onClick={() => void startRecording()}>
                  Record
                </button>
              ) : (
                <button type="button" className="chip active" onClick={() => void stopAndSaveRecording()}>
                  Stop &amp; Save ({recordedSteps.length})
                </button>
              )}
            </div>
            {isRecording && (
              <p className="toggleHint">
                Recording — {recordedSteps.length} step{recordedSteps.length === 1 ? '' : 's'} captured so far.
              </p>
            )}

            <div className="fieldRow">
              <label>Edit as JSON</label>
            </div>
            <textarea
              className="numberInput"
              style={{ width: '100%', minHeight: '60px', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}
              value={macroJsonText}
              onChange={(e) => setMacroJsonText(e.target.value)}
              placeholder='[{"type":"click","selector":"#submit"}]'
            />
            <div className="chipRow">
              <button type="button" className="chip" onClick={loadStepsIntoEditor}>
                Load saved steps
              </button>
              <button type="button" className="chip" onClick={saveStepsFromEditor}>
                Save JSON
              </button>
            </div>
            {macroJsonError && <p className="toggleHint">Invalid JSON — {macroJsonError}</p>}
          </>
        )}
      </div>
      </>
      )}

      {activeTab === 'settings' && (
      <>
      <div className="section">
        <p className="sectionLabel">Appearance</p>
        <p className="toggleHint" style={{ margin: '0 0 6px 4px' }}>
          Applies everywhere, not just this tab.
        </p>

        <div className="fieldRow" style={{ alignItems: 'center' }}>
          <label htmlFor="glass-opacity">Glass transparency</label>
          <input
            id="glass-opacity"
            type="range"
            min={0}
            max={100}
            value={Math.round(appearance.glassOpacity * 100)}
            onChange={(e) => void applyAppearance({ glassOpacity: Number(e.target.value) / 100 })}
            style={{ flex: 1 }}
          />
          <span className="durationUnit" style={{ minWidth: '32px', textAlign: 'right' }}>
            {Math.round(appearance.glassOpacity * 100)}%
          </span>
        </div>

        <div className="fieldRow">
          <label>Accent color</label>
          <div className="swatchRow">
            {ACCENT_COLORS.map((color) => {
              const pair = ACCENT_COLOR_VALUES[color];
              const selected = appearance.accentColor === color;
              return (
                <button
                  key={color}
                  type="button"
                  className={`swatch${selected ? ' selected' : ''}`}
                  aria-label={color}
                  aria-pressed={selected}
                  style={{ background: `linear-gradient(135deg, ${pair.light}, ${pair.dark})` }}
                  onClick={() => void applyAppearance({ accentColor: color })}
                >
                  {selected && (
                    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
                      <path d="M2.2 6.2 4.8 8.8 9.8 3.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="toggleRow">
          <span className="toggleLabel">
            Reduce motion
            <span className="toggleHint">Turns off toggle and segmented-control animations</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={appearance.reduceMotion}
            onChange={(e) => void applyAppearance({ reduceMotion: e.target.checked })}
          />
        </div>
        <div className="toggleRow">
          <span className="toggleLabel">
            Show badge count
            <span className="toggleHint">Shows the number of actively refreshing tabs on the toolbar icon</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={appearance.showBadgeCount}
            onChange={(e) => void applyAppearance({ showBadgeCount: e.target.checked })}
          />
        </div>
      </div>
      </>
      )}

      {state.paused && state.active && (
        <button
          type="button"
          className="primaryButton"
          onClick={async () => {
            if (!tabId) return;
            await browser.runtime.sendMessage({ type: 'resume', tabId });
            setState({ ...state, paused: false });
          }}
        >
          Resume
        </button>
      )}

      <button
        type="button"
        className={`primaryButton${state.active ? ' stop' : ''}`}
        onClick={() => void handleStartStop()}
      >
        {state.active ? 'Stop refreshing' : 'Start refreshing'}
      </button>

      <div className="footer">
        <span>MIT licensed, no account required</span>
        <a href="https://github.com/officenotfound/watchtab" target="_blank" rel="noreferrer">
          source
        </a>
      </div>
    </div>
  );
}

export default App;
