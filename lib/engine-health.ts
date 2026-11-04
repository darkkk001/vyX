import "server-only";

// PRIORITY 1 (FAILOVER), part one: DO NOT SEND AN ORDER TO AN ENGINE THAT IS NOT THERE.
//
// The guard in lib/engine-ingress.ts was already safe when the engine died -- it refused to fill twice
// -- but "safe" meant the trader got a 502 over an order that may or may not exist. The requirement is
// stronger than safe: a down engine must be INVISIBLE. The order simply takes the web path it took
// before the ingress existed, and nobody notices.
//
// -- WHY NOT THE HEARTBEAT. Measured, and it is the first thing anyone would reach for.
//
// The engine writes "RiskEngineHeartbeat" (name 'risk') every 3 s and declares itself stale after
// `staleAfterSecs` (30). lib/risk-owner.ts already reads exactly that row to decide whether an
// engine-owned account is still engine-owned -- the engine-down watchdog of docs/STAGE6-PLAN.md
// section 14 -- so reusing it here looked like the obvious answer. It is the wrong one. The engine's
// idle gate deliberately skips the beat when there is nothing to do:
//
//   2026-11-03T22:01:01Z  market_data::activity: idle gate: skipping until the book can move
//                         timer="risk heartbeat" reason="book closed (no fresh tick on any symbol)"
//
// Read off prod while writing this: the engine was up, answering /health and serving its order route,
// and its heartbeat row was 1693 seconds old -- because the market was shut. A gate built on that row
// would turn the engine ingress OFF every weekend, and flap it on every feed-quiet stretch longer than
// half a minute during a session. The row answers "can the book move". That is a real question, and it
// is not this one. Two notions of "engine down" that can disagree is precisely how an order ends up
// somewhere nobody intended, so this module does not keep both.
//
// WHAT IT ASKS INSTEAD. `GET /v1/orders/engine-health` on the gateway, which shares a loopback with
// the engine and can therefore probe it in microseconds. That answers "is the order path up", which is
// the question actually being asked, and it stays true across a closed market.
//
// -- THE THREE LAYERS, and only one of them is load-bearing.
//
//   1. THE PROBE (here) notices a dead engine within about a TTL, before any order is sent. An
//      optimisation: it removes the one slow order that would otherwise discover the death.
//   2. THE BREAKER (here) is the fast correction for what the probe cannot catch -- an engine that
//      dies in the microsecond after answering it. The FIRST order that fails to reach the engine
//      takes it out of rotation, so every order after that pays nothing at all.
//   3. THE IDEMPOTENCY KEY (lib/engine-ingress.ts, and the engine's own write) is the GUARANTEE. An
//      order caught mid-failure is made harmless by it, not by either check above.
//
// Layers 1 and 2 are about latency. Only layer 3 is about correctness, and it does not depend on
// either of them being right.

/** The gateway endpoint that actually knows. Same base URL the ingress forwards orders to. */
const GATEWAY_URL = (process.env.ENGINE_INGRESS_GATEWAY_URL ?? "").trim();

/**
 * How long one probe verdict is reused.
 *
 * Short, because it is what stands between "the engine died" and "we noticed"; not zero, because an
 * HTTP probe in front of every order is exactly the latency this cutover exists to remove. With
 * stale-while-revalidate below, a trader placing orders in a row waits for a probe at most once -- and
 * in practice never, since the refresh runs behind their previous order.
 */
const TTL_MS = Number(process.env.ENGINE_HEALTH_TTL_MS ?? 2_000);

/** The probe's own deadline. It is a loopback call behind one TLS hop; a slow answer is a bad answer. */
const PROBE_TIMEOUT_MS = Number(process.env.ENGINE_HEALTH_PROBE_TIMEOUT_MS ?? 1_500);

/**
 * How long a failed forward keeps the engine out of rotation.
 *
 * Chosen against the deploy, not out of the air: the engine restarts in this cutover take about four
 * seconds, so 15 s is long enough that a genuinely dead engine is not retried per order, and short
 * enough that a restart is picked up within a few orders rather than needing a web deploy. While it is
 * open NOTHING is sent to the engine and no probe is made either, so an engine-down episode costs the
 * order path nothing whatsoever.
 */
const BREAKER_MS = Number(process.env.ENGINE_BREAKER_MS ?? 15_000);

type Verdict = { up: boolean; at: number };
let cached: Verdict | null = null;
let refreshing = false;
let breakerUntil = 0;

async function probe(): Promise<boolean> {
  if (!GATEWAY_URL) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/orders/engine-health`, { signal: controller.signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Take the engine out of rotation now.
 *
 * Called by the ingress the moment a forward fails in a way that says the engine or the gateway is not
 * answering -- a network error, a timeout, a 5xx. At most ONE order pays the cost of discovering the
 * engine is gone; every order after it goes straight down the web path with no forward and no probe.
 */
export function tripEngineBreaker(why: string): void {
  breakerUntil = Date.now() + BREAKER_MS;
  cached = { up: false, at: Date.now() };
  console.error("[engine-health] engine taken out of rotation", { why, forMs: BREAKER_MS });
}

/** A forward succeeded, so whatever we thought was wrong is not. */
export function clearEngineBreaker(): void {
  if (breakerUntil !== 0) {
    breakerUntil = 0;
    console.warn("[engine-health] engine back in rotation");
  }
}

export function engineBreakerOpen(): boolean {
  return Date.now() < breakerUntil;
}

/**
 * Is the engine worth handing an order to?
 *
 * FALSE IS ALWAYS THE SAFE ANSWER and is what every uncertainty returns -- a tripped breaker, a failed
 * probe, no gateway configured. False means "fill it on the web path", which is what this route did
 * for its whole life before the ingress existed. There is no state of this function that can make an
 * order fail; the worst it can do is decline an optimisation.
 *
 * STALE-WHILE-REVALIDATE past the TTL: the previous verdict is returned and the probe runs behind the
 * request, so nobody waits on it except on the very first order after a cold start.
 */
export async function engineIsLive(): Promise<boolean> {
  if (engineBreakerOpen()) return false;

  const now = Date.now();
  if (cached) {
    if (now - cached.at <= TTL_MS) return cached.up;
    if (!refreshing) {
      refreshing = true;
      void probe()
        .then((up) => {
          cached = { up, at: Date.now() };
        })
        .finally(() => {
          refreshing = false;
        });
    }
    return cached.up;
  }

  const up = await probe();
  cached = { up, at: Date.now() };
  return up;
}

/** Tests only: forget the cached verdict and close the breaker. */
export function __resetEngineHealth(): void {
  cached = null;
  refreshing = false;
  breakerUntil = 0;
}
