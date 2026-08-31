// hotfix/terminal-live-bugs round 4 -- runtime (not build-time) debug gate
// for the tick-sync diagnostic logging in WebTrader.tsx/KLineChartPanel.tsx.
// A build-time NEXT_PUBLIC_* env var can't be toggled per-visit, which
// matters here specifically: reproducing this bug requires testing against
// the real deployed production site (the one place with a working
// cross-subdomain session cookie and a real high-frequency tick feed) --
// see the round-4 investigation notes for why a localhost dev server can
// never legitimately exercise that WS auth path at all. Never active for
// a real trader unless they explicitly add ?tickDebug=1 to the URL.
export function isTickDebug(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("tickDebug") === "1";
}
