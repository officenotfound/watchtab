import { browser } from 'wxt/browser';
import type { TabWatchState } from '@/lib/types';

const POLL_INTERVAL_MS = 1000;
const OVERLAY_ID = 'watchtab-countdown-overlay';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    let overlay: HTMLDivElement | null = null;
    let pollHandle: number | null = null;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;

    // Holding an open port keeps the background service worker alive for as
    // long as this tab is actively refreshing, so its in-memory setTimeout
    // scheduler (needed for sub-30s intervals — see background.ts) survives
    // instead of being evicted between refreshes.
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
      } satisfies Partial<CSSStyleDeclaration>);
      document.documentElement.appendChild(el);
      overlay = el;
      return el;
    }

    function removeOverlay(): void {
      overlay?.remove();
      overlay = null;
    }

    function renderState(state: TabWatchState | null): void {
      if (!state || !state.active || !state.showCountdown) {
        removeOverlay();
        return;
      }

      const el = ensureOverlay();

      if (state.paused) {
        el.textContent = 'watchtab — paused';
        return;
      }
      if (!state.nextRefreshAt) {
        el.textContent = 'watchtab — waiting';
        return;
      }
      const remainingSec = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
      el.textContent = `watchtab — next refresh in ${remainingSec}s`;
    }

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
    });
  },
});
