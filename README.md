# watchtab

watchtab is an open-source browser extension that auto-refreshes a tab on a timer and, on the page itself, shows you a live countdown to the next reload. Everything runs locally in your browser: no account, no server, no remote config that can silently gate features behind a paywall or a "contact support to unlock" wall the way closed-source refresh extensions tend to. You can read every line of the extension that's running.

## Phase 1 features

- **Interval modes**: fixed (pick seconds), random (min/max range), or custom duration (hours/minutes/seconds)
- **Quick-select presets**: 5s, 10s, 15s, 30s, 1m, 5m
- **Start/stop** refreshing the active tab with one click
- **Hard refresh** toggle to bypass the browser cache
- **Refresh limit**: stop automatically after N refreshes, or leave it unlimited
- **Live refresh count** shown in the popup while a tab is being watched
- **Pause on interaction**: automatically pauses the timer if you click, type, or scroll on the page, so it never yanks the page out from under you mid-read
- **On-page countdown**: a small, unobtrusive corner overlay showing seconds until the next refresh, with resume after a pause

Per-tab state (interval, mode, refresh count, pause state) is tracked independently for every tab you enable it on, and cleaned up automatically when a tab closes.

Page-change monitoring (watching for specific content or keywords to appear) is planned for a later phase and isn't part of this release.

## Development

```sh
npm install
npm run dev      # loads a live-reloading unpacked extension via WXT
npm run build    # production build to .output/chrome-mv3
npm run compile  # typecheck only
```

WXT prints the path to load as an unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load unpacked) after `npm run dev` or `npm run build`.

## Contributing

Issues and pull requests are welcome. This is a small, focused codebase (TypeScript, React, WXT) — keep changes scoped and typechecked (`npm run compile`) before opening a PR.

## License

MIT, see [LICENSE](./LICENSE).
