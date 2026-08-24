import { browser } from 'wxt/browser';
import { evaluateAllExpressions, hashString, parseTopLevelExpressions, type ExpressionResult } from '@/lib/matcher';
import { generateSelector } from '@/lib/selector';
import type {
  AutomationTrigger,
  ContentCommand,
  MacroStep,
  MonitorConfig,
  MonitorRuntimeState,
  MonitorTriggerKind,
  PickerTarget,
  TabWatchState,
} from '@/lib/types';

const POLL_INTERVAL_MS = 1000;
const OVERLAY_ID = 'watchtab-countdown-overlay';
const HIGHLIGHT_CLASS = 'watchtab-highlight';
const PICKER_HOVER_CLASS = 'watchtab-picker-hover';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    let overlay: HTMLDivElement | null = null;
    let pollHandle: number | null = null;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;
    const pageLoadedAt = Date.now();

    // ---- keepalive port (unchanged from phase 1) ----------------------------

    function ensurePort(): void {
      if (port) return;
      port = browser.runtime.connect({ name: 'watchtab-keepalive' });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    }

    function releasePort(): void {
      port?.disconnect();
      port = null;
    }

    // ---- on-page overlay: refresh countdown + monitor status ----------------

    function ensureOverlay(): HTMLDivElement {
      if (overlay) return overlay;
      const el = document.createElement('div');
      el.id = OVERLAY_ID;
      Object.assign(el.style, {
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        zIndex: '2147483647',
        background: '#1c1d1b',
        color: '#faf9f6',
        fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        letterSpacing: '0.02em',
        padding: '6px 10px',
        borderRadius: '3px',
        border: '1px solid #2c4a52',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        pointerEvents: 'none',
        userSelect: 'none',
        lineHeight: '1.5',
        whiteSpace: 'nowrap',
      } satisfies Partial<CSSStyleDeclaration>);
      document.documentElement.appendChild(el);
      overlay = el;
      return el;
    }

    function removeOverlay(): void {
      overlay?.remove();
      overlay = null;
    }

    function siteConditionsStatusLine(state: TabWatchState): string | null {
      const { siteConditions, siteConditionsState } = state;
      if (!siteConditions.captchaDetection && !siteConditions.errorDetection) return null;
      const parts: string[] = [];
      if (siteConditions.captchaDetection) {
        parts.push(siteConditionsState.captchaDetected ? 'captcha detected' : 'no captcha');
      }
      if (siteConditions.errorDetection) {
        parts.push(siteConditionsState.errorDetected ? 'error page detected' : 'no error');
      }
      return `conditions: ${parts.join(', ')}`;
    }

    function monitorStatusLine(state: TabWatchState): string | null {
      if (!state.monitor.enabled) return null;
      if (state.monitorState.error) return `monitor: ${state.monitorState.error}`;
      const modeLabel =
        state.monitor.alertMode === 'found'
          ? 'found'
          : state.monitor.alertMode === 'lost'
            ? 'lost'
            : 'watching for changes';
      const matchLabel = state.monitorState.currentlyMatching ? 'matching' : 'not matching';
      return state.monitor.alertMode === 'any-change'
        ? `monitor: ${modeLabel}`
        : `monitor: ${modeLabel} (${matchLabel})`;
    }

    function renderState(state: TabWatchState | null): void {
      const monitorLine = state ? monitorStatusLine(state) : null;
      const conditionsLine = state ? siteConditionsStatusLine(state) : null;
      const showRefreshLine = !!state && state.active && state.showCountdown;

      if (!showRefreshLine && !monitorLine && !conditionsLine) {
        removeOverlay();
        return;
      }

      const el = ensureOverlay();
      const lines: string[] = [];

      if (showRefreshLine && state) {
        if (state.paused) {
          lines.push('Watchtab: paused');
        } else if (!state.nextRefreshAt) {
          lines.push('Watchtab: waiting');
        } else {
          const remainingSec = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
          lines.push(`Watchtab: next refresh in ${remainingSec}s`);
        }
      }

      if (monitorLine) lines.push(monitorLine);
      if (conditionsLine) lines.push(conditionsLine);

      el.textContent = '';
      lines.forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
    }

    // ---- monitor scanning -----------------------------------------------------

    function getScopeRoot(monitor: MonitorConfig): { root: Element | null; error: string | null } {
      if (monitor.scopeMode === 'full-page' || !monitor.customSelector.trim()) {
        return { root: document.body ?? document.documentElement, error: null };
      }
      try {
        const found = document.querySelector(monitor.customSelector);
        if (!found) {
          return { root: null, error: `Custom area selector not found: ${monitor.customSelector}` };
        }
        return { root: found, error: null };
      } catch {
        return { root: null, error: `Invalid custom area selector: ${monitor.customSelector}` };
      }
    }

    function extractText(root: Element, mode: MonitorConfig['extractionMode']): string {
      if (mode === 'source') return root.outerHTML;
      return (root as HTMLElement).innerText ?? root.textContent ?? '';
    }

    function clearHighlights(root: ParentNode): void {
      const marks = root.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`);
      marks.forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parent.normalize();
      });
    }

    /** Wraps the first occurrence of each highlight term found in text nodes under root, without disturbing DOM structure. */
    function highlightTerms(root: Element, terms: string[]): void {
      if (terms.length === 0) return;
      const lowerTerms = terms.filter((t) => t.length > 0).map((t) => t.toLowerCase());
      if (lowerTerms.length === 0) return;

      const remaining = new Set(lowerTerms);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parentTag = node.parentElement?.tagName;
          if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'MARK') {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes: Text[] = [];
      let n: Node | null;
      // eslint-disable-next-line no-cond-assign
      while ((n = walker.nextNode())) textNodes.push(n as Text);

      for (const node of textNodes) {
        if (remaining.size === 0) break;
        const value = node.nodeValue ?? '';
        const lowerValue = value.toLowerCase();

        for (const term of Array.from(remaining)) {
          const idx = lowerValue.indexOf(term);
          if (idx === -1) continue;

          const before = value.slice(0, idx);
          const match = value.slice(idx, idx + term.length);
          const after = value.slice(idx + term.length);

          const mark = document.createElement('mark');
          mark.className = HIGHLIGHT_CLASS;
          Object.assign(mark.style, {
            background: '#ffe94d',
            color: '#1c1d1b',
            padding: '0',
          } satisfies Partial<CSSStyleDeclaration>);
          mark.textContent = match;

          const parent = node.parentNode;
          if (!parent) continue;
          const afterNode = document.createTextNode(after);
          parent.insertBefore(document.createTextNode(before), node);
          parent.insertBefore(mark, node);
          parent.insertBefore(afterNode, node);
          parent.removeChild(node);

          remaining.delete(term);
          break;
        }
      }
    }

    function determineTrigger(
      monitor: MonitorConfig,
      prev: MonitorRuntimeState,
      matchedNow: Set<string>,
      anyMatch: boolean,
      snapshotHash: string,
    ): { triggered: boolean; kind: MonitorTriggerKind | null } {
      if (monitor.alertMode === 'any-change') {
        const triggered = prev.lastSnapshotHash !== null && prev.lastSnapshotHash !== snapshotHash;
        return { triggered, kind: triggered ? 'any-change' : null };
      }

      const prevMatched = new Set(prev.matchedKeys);
      const transitionedToFound = [...matchedNow].some((k) => !prevMatched.has(k));

      if (monitor.alertMode === 'found') {
        const triggered = monitor.skipRepeat ? transitionedToFound : anyMatch;
        return { triggered, kind: triggered ? 'found' : null };
      }

      // alertMode === 'lost'
      const transitionedToLost = [...prevMatched].some((k) => !matchedNow.has(k));
      const triggered = monitor.skipRepeat
        ? transitionedToLost
        : !anyMatch && prev.hasEverMatched;
      return { triggered, kind: triggered ? 'lost' : null };
    }

    async function runScan(state: TabWatchState): Promise<void> {
      const { monitor, monitorState: prev } = state;
      if (!monitor.enabled) return;
      if (Date.now() - pageLoadedAt < monitor.waitForLoadMs) return;

      const { root, error: scopeError } = getScopeRoot(monitor);

      if (!root) {
        const nextState: MonitorRuntimeState = {
          ...prev,
          lastScanAt: Date.now(),
          error: scopeError,
          currentlyMatching: false,
        };
        await browser.runtime
          .sendMessage({
            type: 'monitor-scan',
            monitorState: nextState,
            triggered: false,
            triggerKind: null,
            stopRefreshRequested: false,
          })
          .catch(() => undefined);
        return;
      }

      clearHighlights(root);

      const expressions = parseTopLevelExpressions(monitor.keywords);
      const text = extractText(root, monitor.extractionMode);
      const results =
        monitor.alertMode === 'any-change' && expressions.length === 0
          ? []
          : evaluateAllExpressions(monitor.keywords, text, root);

      const firstError = results.find((r) => r.error)?.error ?? null;
      const matchedNow = new Set(results.filter((r) => r.matched).map((r) => r.expr));
      const anyMatch = matchedNow.size > 0;
      const snapshotHash = hashString(text);

      const { triggered, kind } = determineTrigger(monitor, prev, matchedNow, anyMatch, snapshotHash);

      if (monitor.highlight && monitor.extractionMode === 'visual') {
        const terms = results.filter((r) => r.matched).flatMap((r) => r.highlightTerms);
        highlightTerms(root, terms);
      }

      const hasEverMatchedNext = prev.hasEverMatched || anyMatch;

      // Independent of the found/lost notification trigger (see the
      // autoClickFiredForMatch doc comment in lib/types.ts): attempted
      // whenever there's a live match not yet acted on, regardless of
      // whether the notification's own skip-repeat edge already came and
      // went before automation was turned on. Only an actual click "uses
      // up" the match streak. A no-op attempt (auto-click still disabled,
      // or no anchor to click) must NOT mark it as fired, or turning
      // auto-click on later while still matching would silently never fire.
      const didAutoClick = anyMatch && !prev.autoClickFiredForMatch && runAutoClickKeyword(state, root, results);

      // Same fix, same reasoning, applied to click-targets/macros configured
      // with the "when-alert-triggers" trigger: this used to ride the
      // one-shot `triggered` flag directly, which meant it could silently
      // never fire if the found/lost edge already happened (and was
      // consumed by skip-repeat) before the user finished wiring up
      // automation. found/lost are re-checked from the current level every
      // scan instead; any-change has no persistent level to re-check, so it
      // still rides the edge trigger (which is fine: any-change can't fire
      // on the very first scan, since it needs a prior snapshot to diff
      // against, so it's not exposed to the "already happened before armed"
      // problem the same way found/lost are).
      const automationConditionActive =
        (monitor.alertMode === 'found' && anyMatch) || (monitor.alertMode === 'lost' && hasEverMatchedNext && !anyMatch);
      // Re-attempted every scan while the condition holds and nothing has
      // actually run yet for it — same "keep trying until it really
      // happens" behavior as auto-click, rather than a single attempt that
      // gets marked "fired" whether or not anything was actually configured
      // or found on the page yet.
      const shouldAttemptAutomation =
        (automationConditionActive && !prev.automationFiredForMatch) || (monitor.alertMode === 'any-change' && triggered);
      const didRunAutomation = shouldAttemptAutomation && runAutomationForTrigger(state, 'when-alert-triggers');

      const nextState: MonitorRuntimeState = {
        lastScanAt: Date.now(),
        matchedKeys: [...matchedNow],
        hasEverMatched: hasEverMatchedNext,
        currentlyMatching: anyMatch,
        lastTriggerAt: prev.lastTriggerAt,
        lastTriggerKind: prev.lastTriggerKind,
        lastSnapshotHash: snapshotHash,
        error: firstError,
        autoClickFiredForMatch: anyMatch && (prev.autoClickFiredForMatch || didAutoClick),
        automationFiredForMatch: automationConditionActive && (prev.automationFiredForMatch || didRunAutomation),
      };

      // Idempotent for found/lost: re-asserted every scan from the current
      // level (matching / lost-having-matched), not the one-shot edge, so it
      // still fires even if that edge already came and went before "Start
      // refreshing" was clicked. any-change has no persistent level to
      // re-check, so it rides the edge trigger like the notification does.
      const stopRefreshRequested =
        !monitor.continueRefreshingAfterAlert &&
        ((monitor.alertMode === 'found' && anyMatch) ||
          (monitor.alertMode === 'lost' && nextState.hasEverMatched && !anyMatch) ||
          (monitor.alertMode === 'any-change' && triggered));

      await browser.runtime
        .sendMessage({ type: 'monitor-scan', monitorState: nextState, triggered, triggerKind: kind, stopRefreshRequested })
        .catch(() => undefined);
    }

    // ---- site conditions: captcha / error heuristics -------------------------
    //
    // These are heuristics, not certainty: sites vary widely in markup and
    // wording. Expected false negatives include custom/branded captcha widgets
    // that don't use the common vendor markers below, and error pages that
    // render a 200 status with a friendly "oops" message instead of a numeric
    // code. Treat detection as "probably", not "definitely".

    const CAPTCHA_IFRAME_MARKERS = ['recaptcha', 'hcaptcha', 'turnstile', 'cloudflare'];
    const CAPTCHA_TEXT_MARKERS = ['verify you are human', "i'm not a robot"];
    const ERROR_TEXT_PHRASES = ['not found', 'page not found', 'service unavailable'];
    // Case-sensitive on purpose: lowercase "404"/"500" style codes appearing in
    // prose (prices, IDs, years) shouldn't false-positive; error pages reliably
    // render the bare numeric code somewhere on the page.
    const ERROR_CODE_PATTERN = /\b(4\d{2}|5\d{2})\b/;

    function detectCaptcha(): boolean {
      const iframes = document.querySelectorAll('iframe[src]');
      for (const frame of iframes) {
        const src = frame.getAttribute('src')?.toLowerCase() ?? '';
        if (CAPTCHA_IFRAME_MARKERS.some((marker) => src.includes(marker))) return true;
      }

      const candidates = document.querySelectorAll('[id], [class]');
      for (const el of candidates) {
        const id = el.id?.toLowerCase() ?? '';
        const className = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        if (id.includes('captcha') || className.includes('captcha')) return true;
      }

      const bodyText = (document.body?.innerText ?? '').toLowerCase();
      return CAPTCHA_TEXT_MARKERS.some((marker) => bodyText.includes(marker));
    }

    function detectErrorPage(): boolean {
      const bodyText = document.body?.innerText ?? '';
      const lowerText = bodyText.toLowerCase();
      if (ERROR_TEXT_PHRASES.some((phrase) => lowerText.includes(phrase))) return true;
      return ERROR_CODE_PATTERN.test(bodyText);
    }

    async function runSiteConditionScan(state: TabWatchState): Promise<void> {
      const { siteConditions } = state;
      if (!siteConditions.captchaDetection && !siteConditions.errorDetection) return;

      const captchaDetected = siteConditions.captchaDetection ? detectCaptcha() : false;
      const errorDetected = siteConditions.errorDetection ? detectErrorPage() : false;

      await browser.runtime
        .sendMessage({ type: 'site-condition-scan', captchaDetected, errorDetected })
        .catch(() => undefined);
    }

    // ---- element picker ---------------------------------------------------

    let pickerActive = false;
    let pickerHoverEl: Element | null = null;
    let pickerTimeout: number | null = null;
    let pickerTarget: PickerTarget = 'custom-area';

    function pickerMouseOver(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Element) || target.id === OVERLAY_ID) return;
      if (pickerHoverEl && pickerHoverEl !== target) {
        pickerHoverEl.classList.remove(PICKER_HOVER_CLASS);
      }
      pickerHoverEl = target;
      target.classList.add(PICKER_HOVER_CLASS);
    }

    function pickerClick(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Element)) return;
      e.preventDefault();
      e.stopPropagation();
      const selector = generateSelector(target);
      void browser.runtime.sendMessage({ type: 'picker-result', selector, target: pickerTarget }).catch(() => undefined);
      exitPicker();
    }

    function pickerKeydown(e: KeyboardEvent): void {
      if (e.key === 'Escape') exitPicker();
    }

    function enterPicker(target: PickerTarget): void {
      if (pickerActive) return;
      pickerActive = true;
      pickerTarget = target;
      if (!document.getElementById('watchtab-picker-style')) {
        const style = document.createElement('style');
        style.id = 'watchtab-picker-style';
        style.textContent = `.${PICKER_HOVER_CLASS} { outline: 2px solid #2c4a52 !important; outline-offset: -1px !important; cursor: crosshair !important; background: rgba(44,74,82,0.12) !important; }`;
        document.head.appendChild(style);
      }
      document.addEventListener('mouseover', pickerMouseOver, true);
      document.addEventListener('click', pickerClick, true);
      document.addEventListener('keydown', pickerKeydown, true);
      // Safety net: auto-exit if the popup was closed mid-pick and never cancels.
      pickerTimeout = window.setTimeout(exitPicker, 60_000);
    }

    function exitPicker(): void {
      if (!pickerActive) return;
      pickerActive = false;
      document.removeEventListener('mouseover', pickerMouseOver, true);
      document.removeEventListener('click', pickerClick, true);
      document.removeEventListener('keydown', pickerKeydown, true);
      pickerHoverEl?.classList.remove(PICKER_HOVER_CLASS);
      pickerHoverEl = null;
      if (pickerTimeout !== null) {
        window.clearTimeout(pickerTimeout);
        pickerTimeout = null;
      }
    }

    browser.runtime.onMessage.addListener((message: ContentCommand) => {
      if (message.type === 'enter-picker-mode') enterPicker(message.target);
      if (message.type === 'exit-picker-mode') exitPicker();
      if (message.type === 'enter-recording-mode') enterRecording();
      if (message.type === 'exit-recording-mode') exitRecording();
    });

    // ---- macro recording ---------------------------------------------------

    let recordingActive = false;

    function sendRecordedStep(step: MacroStep): void {
      void browser.runtime.sendMessage({ type: 'macro-step-recorded', step }).catch(() => undefined);
    }

    function recordingClick(e: MouseEvent): void {
      const target = e.target;
      if (!(target instanceof Element) || target.id === OVERLAY_ID) return;
      sendRecordedStep({ type: 'click', selector: generateSelector(target) });
    }

    function recordingInput(e: Event): void {
      const target = e.target;
      if (target instanceof HTMLSelectElement) {
        sendRecordedStep({ type: 'select', selector: generateSelector(target), value: target.value });
      } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        sendRecordedStep({ type: 'fill', selector: generateSelector(target), value: target.value });
      }
    }

    const IGNORED_RECORDING_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

    function recordingKeydown(e: KeyboardEvent): void {
      if (IGNORED_RECORDING_KEYS.has(e.key)) return;
      const target = e.target;
      sendRecordedStep({
        type: 'keypress',
        key: e.key,
        selector: target instanceof Element ? generateSelector(target) : undefined,
      });
    }

    function enterRecording(): void {
      if (recordingActive) return;
      recordingActive = true;
      document.addEventListener('click', recordingClick, true);
      document.addEventListener('input', recordingInput, true);
      document.addEventListener('keydown', recordingKeydown, true);
    }

    function exitRecording(): void {
      if (!recordingActive) return;
      recordingActive = false;
      document.removeEventListener('click', recordingClick, true);
      document.removeEventListener('input', recordingInput, true);
      document.removeEventListener('keydown', recordingKeydown, true);
    }

    // ---- automation: auto-click keyword link + additional click targets ----

    /** Finds the nearest <a> ancestor for whatever DOM node produced a matched expression, if any. */
    function locateMatchAnchor(root: Element, results: ExpressionResult[]): HTMLAnchorElement | null {
      for (const r of results) {
        if (!r.matched) continue;

        if (r.kind === 'xpath') {
          try {
            const doc = root.ownerDocument ?? document;
            const rawXpath = r.expr.slice(2);
            // Same fix as lib/matcher.ts's evaluateXPath: a leading "//" is
            // anchored to the document root regardless of context node, so
            // rewrite it to ".//" to actually respect a custom-area scope.
            const xpath = rawXpath.startsWith('//') ? `.${rawXpath}` : rawXpath;
            const evalResult = doc.evaluate(xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const node = evalResult.singleNodeValue;
            const el = node instanceof Element ? node : node?.parentElement ?? null;
            const anchor = el?.closest('a');
            if (anchor) return anchor as HTMLAnchorElement;
          } catch {
            // Invalid XPath already surfaced as a monitor error elsewhere.
          }
          continue;
        }

        for (const term of r.highlightTerms) {
          if (!term) continue;
          const lower = term.toLowerCase();
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n: Node | null;
          // eslint-disable-next-line no-cond-assign
          while ((n = walker.nextNode())) {
            const value = (n.nodeValue ?? '').toLowerCase();
            if (value.includes(lower)) {
              const anchor = n.parentElement?.closest('a');
              if (anchor) return anchor as HTMLAnchorElement;
              break;
            }
          }
        }
      }
      return null;
    }

    /** Returns whether a click actually fired, so the caller can tell an intentional no-op (disabled, no anchor) from a real action. */
    function runAutoClickKeyword(state: TabWatchState, root: Element, results: ExpressionResult[]): boolean {
      if (!state.automation.autoClickKeyword) return false;
      const anchor = locateMatchAnchor(root, results);
      if (!anchor) return false;
      if (state.automation.autoClickOpenNewTab) {
        const href = anchor.href;
        if (!href) return false;
        window.open(href, '_blank', 'noopener');
      } else {
        anchor.click();
      }
      return true;
    }

    /** Returns whether an element was actually found and clicked. */
    function clickSelectorIfPresent(selector: string): boolean {
      if (!selector.trim()) return false;
      try {
        const el = document.querySelector(selector);
        if (!el) return false;
        (el as HTMLElement).click();
        return true;
      } catch {
        // Invalid selector: ignore rather than throw, per spec.
        return false;
      }
    }

    /** Returns whether at least one configured target for this trigger was actually clicked. */
    function runClickTargets(state: TabWatchState, trigger: AutomationTrigger): boolean {
      let didClick = false;
      for (const target of state.automation.clickTargets) {
        if (target.trigger === trigger && clickSelectorIfPresent(target.selector)) didClick = true;
      }
      return didClick;
    }

    // ---- macros: recorded step-sequence playback ---------------------------

    const MACRO_STEP_GAP_MS = 200;

    function sleep(ms: number): Promise<void> {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    function dispatchInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function executeMacroStep(step: MacroStep): Promise<void> {
      try {
        switch (step.type) {
          case 'click': {
            const el = document.querySelector(step.selector);
            (el as HTMLElement | null)?.click();
            break;
          }
          case 'fill': {
            const el = document.querySelector(step.selector);
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              dispatchInputValue(el, step.value);
            }
            break;
          }
          case 'select': {
            const el = document.querySelector(step.selector);
            if (el instanceof HTMLSelectElement) {
              el.value = step.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            break;
          }
          case 'keypress': {
            const el = step.selector ? document.querySelector(step.selector) : document.activeElement;
            if (el instanceof HTMLElement) {
              el.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, bubbles: true }));
            }
            break;
          }
          case 'wait': {
            await sleep(Math.max(0, step.durationMs));
            break;
          }
          case 'navigate': {
            window.location.href = step.url;
            break;
          }
          case 'scroll': {
            if (step.target === 'top') {
              window.scrollTo({ top: 0, behavior: 'auto' });
            } else if (step.target === 'bottom') {
              window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
            } else {
              document.querySelector(step.target)?.scrollIntoView({ block: 'center' });
            }
            break;
          }
        }
      } catch {
        // A single bad step (invalid selector, etc.) shouldn't abort the rest of the macro.
      }
    }

    let macroRunning = false;

    async function runMacro(steps: MacroStep[]): Promise<void> {
      if (macroRunning || steps.length === 0) return;
      macroRunning = true;
      try {
        for (const step of steps) {
          await executeMacroStep(step);
          await sleep(MACRO_STEP_GAP_MS);
        }
      } finally {
        macroRunning = false;
      }
    }

    /**
     * Returns whether a real action actually happened (a click landed, or a
     * macro was actually kicked off) — not just whether the trigger
     * condition was met. This matters for the caller's "already fired for
     * this match" bookkeeping: if nothing was configured yet (no click
     * targets for this trigger, no matching macro), or a configured
     * selector simply wasn't on the page, marking it "fired" would mean it
     * never gets another chance once the user finishes configuring
     * automation or the element actually appears.
     */
    function runAutomationForTrigger(state: TabWatchState, trigger: AutomationTrigger): boolean {
      const didClick = runClickTargets(state, trigger);
      const willRunMacro = state.macro.enabled && state.macro.trigger === trigger && state.macro.steps.length > 0;
      if (willRunMacro) void runMacro(state.macro.steps);
      return didClick || willRunMacro;
    }

    let eachRefreshAutomationRan = false;

    // ---- polling loop -------------------------------------------------------

    async function poll(): Promise<void> {
      const state = (await browser.runtime
        .sendMessage({ type: 'get-my-state' })
        .catch(() => null)) as TabWatchState | null;
      renderState(state);
      if (state?.active && !state.paused) {
        ensurePort();
      } else {
        releasePort();
      }
      if (state) {
        // "each-refresh" means once per page load caused by an actual
        // refresh cycle; a tab that has monitoring/automation configured but
        // never had "Start refreshing" clicked isn't refreshing at all, so
        // there's no refresh for this to run "each" of.
        if (state.active && !eachRefreshAutomationRan) {
          eachRefreshAutomationRan = true;
          runAutomationForTrigger(state, 'each-refresh');
        }
        await runScan(state).catch(() => undefined);
        await runSiteConditionScan(state).catch(() => undefined);
      }
    }

    function reportInteraction(): void {
      void browser.runtime.sendMessage({ type: 'user-interaction' }).catch(() => undefined);
    }

    document.addEventListener('click', reportInteraction, { capture: true, passive: true });
    document.addEventListener('keydown', reportInteraction, { capture: true, passive: true });
    document.addEventListener('scroll', reportInteraction, { capture: true, passive: true });

    pollHandle = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();

    window.addEventListener('beforeunload', () => {
      if (pollHandle !== null) window.clearInterval(pollHandle);
      removeOverlay();
      releasePort();
      exitPicker();
    });
  },
});
