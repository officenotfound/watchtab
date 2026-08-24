// test11 (window-focus on detection) — SKIPPED.
//
// "Window focus on detection" calls chrome.windows.update({focused:true}) and
// chrome.tabs.update({active:true}) on trigger (entrypoints/background.ts,
// fireMonitorAlert()). Real OS-level window/tab focus isn't reliably observable
// or drivable from a Playwright CDP session: Playwright's own tab switches don't
// go through the OS window manager, headless/headed focus behavior differs across
// CI environments and OSes, and there is no cross-platform way to assert "this
// Chrome window has real OS input focus" without flakiness. Rather than writing a
// test that could pass/fail based on the host machine's window manager state
// instead of the extension's logic, this is intentionally left as a documented
// skip per the task instructions.
console.log('RESULT: SKIPPED — window-focus-on-detection requires real OS window focus, not reliably testable via Playwright/CDP; see comments in this file for rationale.');
