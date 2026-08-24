import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  createDefaultState,
  resolveIntervalSeconds,
  type IntervalMode,
  type MonitorAlertMode,
  type MonitorConfig,
  type TabWatchState,
} from '@/lib/types';
import './App.css';

const FIXED_PRESETS = [5, 10, 15, 30, 60, 300];

function formatPreset(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
}

function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabTitle, setTabTitle] = useState('');
  const [state, setState] = useState<TabWatchState | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
      <div className="app">
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
      },
    });
  }

  async function applyMonitor(partial: Partial<MonitorConfig>) {
    if (!state) return;
    await applyLiveSettings({ monitor: { ...state.monitor, ...partial } });
  }

  async function pickElement() {
    if (!tabId) return;
    await browser.runtime.sendMessage({ type: 'start-picker', tabId });
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
    <div className="app">
      <div className="header">
        <p className="brand">watchtab</p>
        <p className="tabUrl" title={tabTitle}>
          {tabTitle}
        </p>
      </div>

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
