# watchtab

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Chromium](https://img.shields.io/badge/chromium-mv3-orange)](#browser-support)

An open-source auto-refresh and page-monitor browser extension. Refresh a tab on a schedule, watch a page for a keyword or any change, get notified the moment it happens.

Some closed-source tools in this category hold core features behind a paywall (AJAX-only refresh, unlimited alerts, higher tiers of "smart monitoring"), and at least one ships a mechanism for a remote server to push configuration or script changes into the extension. watchtab was built as a direct alternative to that model. Every setting lives in your browser's own local storage, and every line of code that runs is sitting in this repo for you to read.

## Features

**Refresh**
- Fixed, random-range, or custom-duration intervals, with quick-select presets (5s/10s/15s/30s/1m/5m)
- Hard refresh (bypass cache), refresh-count limits, pause automatically on click/scroll/typing
- On-page countdown overlay

**Monitor**
- Full-page or CSS-scoped custom-area monitoring, with a click-to-pick element selector
- Four expression syntaxes in one field: plain keywords, `##boolean AND/OR##` expressions, `@@XPath`, and `$regex`
- Visible-text or raw-source matching, alert on keyword found / lost / any change
- Skip-repeat, wait-for-content-to-load, on-page highlighting of matches, window-focus on detection
- Starter expression templates for common cases (stock, price, shopping actions)

**Site conditions**
- Captcha detection, broken/error-page detection (4xx/5xx and common error-page text), each with an optional sound alert
- Redirect handling: follow all redirects, or stop refreshing if the tab navigates away from where it started

**Automation**
- Auto-click a matched keyword's link, or click other page elements on every refresh or only when an alert triggers
- Cookie rules (set/delete, before or after refresh)
- Recordable macros (click, fill, select, keypress, wait, navigate, scroll) with a hand-editable JSON view

Everything is scoped per tab and cleaned up automatically when the tab closes.

## Browser support

| Browser | Status |
|---|---|
| Chrome / Brave / other Chromium browsers | Supported (MV3) |
| Edge | Should work as-is via the same Chromium MV3 build; not yet submitted to the Edge Add-ons store |
| Firefox | Planned. WXT supports a Firefox target, not yet built or verified here. |
| Safari | Not planned near-term. Requires a native app wrapper via Xcode, out of scope for now. |

## Installation (unpacked, for now)

Not yet published to any extension store. To run it locally:

```sh
git clone https://github.com/officenotfound/watchtab.git
cd watchtab
npm install
npm run build
```

Then in Chrome or Brave: go to `chrome://extensions` (or `brave://extensions`), enable **Developer mode**, click **Load unpacked**, and select the `.output/chrome-mv3` folder.

## Development

```sh
npm install
npm run dev      # live-reloading unpacked extension via WXT
npm run build    # production build to .output/chrome-mv3
npm run compile  # typecheck only, no build
```

### Testing

The extension is covered by a Playwright end-to-end suite in `e2e/` that loads the actual unpacked build into a real headless Chromium instance and drives it: clicking through the popup, mutating live page content, and reading back real extension storage state, rather than testing against mocks. Run any test directly:

```sh
npm run build
node e2e/test1-found.mjs
```

Each test file is self-contained and prints `RESULT: PASS` or `RESULT: FAIL`. Tests always run with `headless: true`-equivalent flags (`--headless=new`); if you're adding a new test, keep it that way. A visible browser window stealing OS focus on every run is not acceptable.

## Contributing

Issues and pull requests are welcome. Keep changes scoped and typechecked (`npm run compile`) before opening a PR, and if you're touching behavior that has E2E coverage, run the relevant test(s) and make sure they still pass.

## License

MIT, see [LICENSE](./LICENSE).
