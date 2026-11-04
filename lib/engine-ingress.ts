import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME } from "@/lib/account-auth";
import { clearEngineBreaker, engineIsLive, tripEngineBreaker } from "@/lib/engine-health";
import { POSITION_DTO_INCLUDE, positionDto } from "@/lib/position-dto";
import { prisma } from "@/lib/prisma";

// THE ENGINE INGRESS (L2 Step 5, owner 2026-11-03).
//
// One designated DEMO account's MARKET orders are filled by the Rust engine instead of by this route.
// Everything else keeps filling here, untouched.
//
// FAIL CLOSED, TWICE OVER. Both the account list and the gateway URL must be configured; either one
// unset or empty means NO account diverts and every order takes the existing path. That is the
// opposite of the usual "unconfigured = unrestricted" default, and it is the point: a deploy that
// forgets a variable turns the ingress OFF, it does not open it to every account.
//
// WHY THE GATEWAY AND NOT THE ENGINE DIRECTLY. The engine listens on the VPS's loopback; this route
// runs on Vercel and cannot reach it. The gateway is the one public door (feed.vyxtrader.com), it
// already resolves a trader session, and it applies its OWN copy of this scoping plus an
// `accountMode = DEMO` assert read from the database. The engine then applies a third copy
// (order_management::ingress). Three independent layers, none of them trusting the other two.
//
// -- FAILOVER (PRIORITY 1). An engine that is down must be invisible, and no failure may double-fill.
//
// Those are two separate problems and they get two separate mechanisms, because one cannot do both.
//
// 1. INVISIBLE. `engineIsLive()` (lib/engine-health.ts) is consulted before anything is forwarded: a
//    failed probe of the engine's order path, or a breaker tripped by the last failed forward, and
//    this function returns null straight away -- the order takes the web path, with the engine never
//    contacted. A down engine therefore costs the trader nothing: not an error, not a timeout, not a
//    retry. (That module explains, with the prod log line, why it probes the gateway rather than
//    reading the heartbeat row: the heartbeat goes stale on a closed market while the engine is fine.)
//
// 2. NEVER TWICE. The health check is a guess about the future and will sometimes be wrong -- the
//    engine can die in the microsecond after it answers. So correctness does not rest on it. It rests
//    on the client's IDEMPOTENCY KEY, which this function now forwards and the engine now writes into
//    `"Order".idempotencyKey`. Two things follow, and the second is the one that matters:
//      - a lost answer is RECOVERABLE: `resolveByKey` below reads the order back by key, so a timeout
//        over a fill that did commit returns that fill rather than a 502 or a second position;
//      - a double fill is IMPOSSIBLE, not merely unlikely: `"Order"` is UNIQUE on
//        (accountId, idempotencyKey) and the engine's whole fill -- order, position, deal, ledger -- is
//        one transaction, so if the web ever fills the same key first the engine's side raises 23505
//        and rolls back entirely. Postgres decides the race; the two services never have to agree.
//
// What this replaces: the old rule was "ambiguous means return 502 and never fill again". That was the
// right half of the design's section 5b.3 (a lost fill is recoverable, a double fill is not), but it
// left the trader holding an error. With a key the ambiguity is simply resolved, so the safe answer and
// the good answer are finally the same answer.

const ACCOUNTS = (process.env.ENGINE_INGRESS_ACCOUNT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATEWAY_URL = (process.env.ENGINE_INGRESS_GATEWAY_URL ?? "").trim();

/** Is this account's MARKET order to be filled by the engine? False whenever anything is unconfigured. */
export function engineFillsFor(accountId: string): boolean {
  return GATEWAY_URL !== "" && ACCOUNTS.includes(accountId);
}

/** For a start-up / health line: the scope this deployment is actually running with. */
export function engineIngressScope(): { enabled: boolean; accounts: number } {
  return { enabled: GATEWAY_URL !== "" && ACCOUNTS.length > 0, accounts: ACCOUNTS.length };
}

/**
 * How long to wait for the engine's answer before giving up on it.
 *
 * SHORTENED FROM TEN SECONDS, and the reason is the key rather than any new confidence about the
 * engine. Ten seconds was the right number when a timeout was unresolvable: the longer this waited,
 * the less often it had to answer "something happened and I cannot tell you what". Now a timeout is
 * resolved by `resolveByKey`, so waiting is no longer buying safety -- it is only making the one
 * unlucky order slow.
 *
 * Sized against what a healthy fill actually takes: the engine's own fill is ~35 ms and the whole
 * gateway path measures p50 ~55 ms, so two seconds is more than thirty times the normal cost. An
 * engine that has not answered in that long is not about to.
 */
const TIMEOUT_MS = Number(process.env.ENGINE_INGRESS_TIMEOUT_MS ?? 2_000);

/**
 * Fill one MARKET order through the gateway -> engine.
 *
 * `null` means THIS ROUTE SHOULD CARRY ON with its own path, and it is returned only when the engine
 * provably wrote nothing:
 *   - 403: the gateway or the engine refused to serve this account (its scoping, or not a DEMO
 *     account). Nothing was written.
 *   - 503: the engine's risk thresholds are not loaded, so its order routes fail closed by design.
 *     Nothing was written.
 *
 * ANY OTHER FAILURE RETURNS AN ERROR RATHER THAN FALLING BACK. A timeout or a 5xx is AMBIGUOUS: the
 * engine may have committed the fill and lost the answer, and filling again here would double it.
 * That is the cutover design's own rule (section 5b.3, "the two failure modes: double fill and lost
 * fill") -- a lost answer is recoverable, a second position is not.
 */
export async function fillThroughEngine(
  body: { symbol?: unknown; side?: unknown; volume?: unknown; type?: unknown; idempotencyKey?: unknown } | null,
  session: { accountId: string; brokerId: string }
): Promise<NextResponse | null> {
  // only MARKET: the gateway's /market route is what this talks to, and a resting LIMIT/STOP belongs
  // to the web's own trigger path either way
  if (!body || body.type !== "MARKET") return null;
  if (typeof body.symbol !== "string" || (body.side !== "BUY" && body.side !== "SELL")) return null;

  // FAILOVER, the precondition for all of it: without a key there is no way to resolve an ambiguous
  // timeout, so an order that has none is not eligible for the engine at all. The web route requires
  // `idempotencyKey` of every order, so this declines nothing a real client sends -- it is here so that
  // a future caller which forgets the key falls back to the web instead of inheriting a path whose only
  // answer to a lost fill would be a 502.
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!key) return null;

  // ... and the health check, before a single byte leaves. A failed probe, or a breaker tripped by the
  // last failed forward: the order goes down the web path and the engine is never contacted.
  if (!(await engineIsLive())) return null;

  // the trader's own session, forwarded: the gateway authenticates the ORDER, not this service
  const token = (await cookies()).get(ACCOUNT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY_URL}/v1/orders/market`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${token}`,
        "x-broker-id": session.brokerId,
      },
      body: JSON.stringify({ symbol: body.symbol, side: body.side, volume: String(body.volume), idempotencyKey: key }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    // Network failure or timeout. AMBIGUOUS -- the fill may have committed and only the answer be lost
    // -- so this never fills again blindly. It asks the database which of the two happened.
    console.error("[engine-ingress] gateway unreachable or timed out", err);
    tripEngineBreaker("forward failed");
    return resolveByKey(session.accountId, key);
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 403 || upstream.status === 503) {
    // Refused before writing -- carry on with this route's own path. 503 is the engine's thresholds not
    // being loaded, which is a real "not ready", so it takes the engine out of rotation too; 403 is a
    // scoping decision about this account and says nothing about the engine's health.
    if (upstream.status === 503) tripEngineBreaker("engine answered 503 (not ready)");
    return null;
  }
  const data = (await upstream.json().catch(() => null)) as { order_id?: string; position_id?: string } | null;
  if (!upstream.ok || !data?.position_id || !data?.order_id) {
    console.error("[engine-ingress] unexpected answer", { status: upstream.status, data });
    // A 5xx is as ambiguous as a timeout: the engine may have committed before whatever broke. Any
    // other unexpected answer is no more knowable, so both go to the same by-key resolution rather
    // than to an assumption about what was written.
    if (upstream.status >= 500) tripEngineBreaker(`engine answered ${upstream.status}`);
    return resolveByKey(session.accountId, key);
  }
  clearEngineBreaker();

  // wave-B: the terminal updates its local state from THIS response and does not re-fetch, so the
  // answer has to carry what a fill on this route's own path carries -- the order, the position DTO
  // and the new balance. Read in one parallel pair rather than three sequential round trips.
  const [order, position, account] = await Promise.all([
    prisma.order.findUnique({ where: { id: data.order_id } }),
    prisma.position.findUnique({ where: { id: data.position_id }, include: POSITION_DTO_INCLUDE }),
    prisma.account.findUnique({ where: { id: session.accountId }, select: { balance: true } }),
  ]);
  if (!order || !position) {
    // the engine says it wrote them, so this is a read-after-write surprise rather than a refusal
    console.error("[engine-ingress] filled but could not read the rows back", data);
    return NextResponse.json({ error: "EXECUTION_UNAVAILABLE" }, { status: 502 });
  }

  const { symbol, originOrder, ...bare } = position;
  return NextResponse.json(
    {
      order,
      position: positionDto(bare, symbol, originOrder?.source ?? null),
      ...(account ? { balance: account.balance } : {}),
      executedBy: "engine",
    },
    { status: 201 }
  );
}

/**
 * The engine's answer was lost. Decide what actually happened, by key.
 *
 * This is the whole of the failover's correctness, and it rests on one property of the write: the
 * engine's `vyx_open_position` creates the `"Order"` row -- under THIS key -- in the same transaction
 * as the position, the deal, the commission and the ledger effect. One transaction, all of it or none
 * of it. So:
 *
 *   - THE ROW IS HERE  => the engine committed. Whatever it decided (filled, or rejected by its own
 *     risk gates) is the order's answer, and this returns it. Filling again would double a position or
 *     overturn a refusal because a socket died.
 *   - THE ROW IS NOT HERE => the engine committed NOTHING. Returning null hands the order back to the
 *     web path, which fills it normally. The trader sees an ordinary fill and never learns the engine
 *     was involved.
 *
 * THE RACE, and why it is not a hole. Between "not here" and the web's own insert, the engine could
 * still commit -- it may have been mid-transaction when we gave up. Then two writers hold the same
 * (accountId, idempotencyKey), and `"Order"`'s UNIQUE index refuses the later one. If the engine loses,
 * its entire fill rolls back, position included; if the web loses, its insert raises 23505 and the
 * route answers from the row that won. Either way exactly one order exists. The bounded re-read below
 * narrows the window for politeness -- so the common case resolves cleanly instead of through a
 * constraint violation -- but the guarantee is the index, not the polling.
 */
async function resolveByKey(accountId: string, idempotencyKey: string): Promise<NextResponse | null> {
  // Three looks over ~250 ms. Sized against what it is waiting for: a transaction that was already
  // in flight when the forward gave up, which either commits within a round trip or two of now, or was
  // never started. Longer would make a genuinely-nothing-written order wait for no reason.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 120));

    const order = await prisma.order.findUnique({
      where: { accountId_idempotencyKey: { accountId, idempotencyKey } },
    }).catch((err: unknown) => {
      console.error("[engine-ingress] could not read the order back by key", err);
      return undefined; // undefined = unknown, distinct from null = definitely absent
    });
    if (order === undefined) {
      // The database is not answering. Falling through to the web path would ask it to fill, which it
      // cannot do either, and would do so without ever having established that nothing was written --
      // so this is the one case that still has to surface as an error.
      return NextResponse.json({ error: "EXECUTION_UNAVAILABLE" }, { status: 502 });
    }
    if (!order) continue;

    console.warn("[engine-ingress] lost answer recovered by key", { orderId: order.id, status: order.status });

    // Filled: answer exactly as the happy path does, so the terminal's wave-B state update is identical
    // whether or not the response came back the first time.
    if (order.status === "FILLED") {
      const [position, account] = await Promise.all([
        prisma.position.findFirst({ where: { originOrderId: order.id }, include: POSITION_DTO_INCLUDE }),
        prisma.account.findUnique({ where: { id: accountId }, select: { balance: true } }),
      ]);
      if (position) {
        const { symbol, originOrder, ...bare } = position;
        return NextResponse.json(
          {
            order,
            position: positionDto(bare, symbol, originOrder?.source ?? null),
            ...(account ? { balance: account.balance } : {}),
            executedBy: "engine",
          },
          { status: 201 }
        );
      }
    }

    // Rejected, or filled without a position this read can see yet: return the order itself, which is
    // what the route's own idempotent-replay branch returns for an already-answered key. 200, not 201 --
    // this request did not create it.
    return NextResponse.json(order, { status: 200 });
  }

  // Nothing under this key after three looks: the engine wrote nothing, so the web path is free to.
  return null;
}
