// Live reference data (owner 2026-10-29, web-reference-events-brief.md): a burst of ConfigChanged events (a bulk symbol edit, a CSV import) reaches
// the apps as at most ONE event per broker and scope per second. The first goes at once; later ones inside the window collapse into a single
// trailing send at the window's end, so the last change is never lost (the apps refetch the table on each event; the event carries no data).
export const CONFIG_COALESCE_MS = 1000;

/** Scopes a trader's terminal never receives: staff and liquidity providers are backoffice reference data. */
export const TRADER_HIDDEN_SCOPES: ReadonlySet<string> = new Set(["permissions", "lps"]);

type Timers = { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown };
const realTimers: Timers = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms) };

export function createConfigCoalescer(windowMs = CONFIG_COALESCE_MS, timers: Timers = realTimers) {
  const state = new Map<string, { lastSent: number; pending: (() => void) | null; scheduled: boolean }>();
  return function coalesce(key: string, send: () => void): void {
    const t = timers.now();
    const s = state.get(key);
    if (!s || t - s.lastSent >= windowMs) {
      state.set(key, { lastSent: t, pending: null, scheduled: false });
      send();
      return;
    }
    s.pending = send; // the newest wins: one trailing send for the whole burst
    if (s.scheduled) return;
    s.scheduled = true;
    timers.setTimeout(() => {
      const cur = state.get(key);
      if (!cur) return;
      const fn = cur.pending;
      cur.pending = null;
      cur.scheduled = false;
      cur.lastSent = timers.now();
      fn?.();
    }, s.lastSent + windowMs - t);
  };
}
