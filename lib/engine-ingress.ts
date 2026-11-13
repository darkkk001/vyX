import "server-only";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME } from "@/lib/account-auth";
import { bearerToken } from "@/lib/app-web";
import { toClientShape } from "@/lib/client-execution";
import { POSITION_DTO_INCLUDE, positionDto } from "@/lib/position-dto";
import { prisma } from "@/lib/prisma";
import { engineLiveAllowed } from "@/lib/risk-authority";

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

const ACCOUNTS = (process.env.ENGINE_INGRESS_ACCOUNT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATEWAY_URL = (process.env.ENGINE_INGRESS_GATEWAY_URL ?? "").trim();

/** Is this account on the DEMO ingress list (ENGINE_INGRESS_ACCOUNT_IDS)? False whenever anything is unconfigured. */
export function engineFillsFor(accountId: string): boolean {
  return GATEWAY_URL !== "" && ACCOUNTS.includes(accountId);
}

// ---- LIVE CUTOVER (owner 2026-11-13): the toggle-based route for LIVE accounts -------------------------------------
//
// A LIVE account goes to the engine when the live allowlist says so -- Broker.engineLiveAllowlistOn AND
// Account.engineLiveEnabled AND accountMode = LIVE (lib/risk-authority.ts engineLiveAllowed, the one rule the engine and
// the gateway implement too; docs/ENGINE-LIVE-ALLOWLIST.md). The DEMO ingress list above is untouched and still the only
// way a DEMO account routes. A LIVE account id typed into that list does NOT route it (the gateway's DEMO assert would
// refuse it anyway); only the toggles do.
//
// FAIL CLOSED: no gateway URL, a failed read, or any condition false = the web fills it, exactly as before. And the
// gateway / engine check the rule again from their own database read: a toggle switched off here a few seconds ago is
// refused there (403), and a refusal falls back to the web path.
//
// COST. The order route runs this before anything else, for every account. So it does NOT read the account per order:
// it keeps the (tiny) set of allowlisted LIVE accounts per instance, re-read on demand at most every LIVE_SET_TTL_MS
// (no timer, so an idle instance reads nothing). A toggle therefore takes effect within that window.


export const LIVE_SET_TTL_MS = 10_000;
let liveSet: { ids: Set<string>; at: number } | null = null;
let liveSetInFlight: Promise<Set<string>> | null = null;

async function readLiveAllowlisted(): Promise<Set<string>> {
  const rows = await prisma.account.findMany({
    where: { accountMode: "LIVE", engineLiveEnabled: true, broker: { engineLiveAllowlistOn: true } },
    select: { id: true, accountMode: true, engineLiveEnabled: true, broker: { select: { engineLiveAllowlistOn: true } } },
  });
  // the query already says it; the shared rule says it again, so the two can never drift apart silently
  return new Set(rows.filter((r) => engineLiveAllowed(r.broker, r.accountMode, r.engineLiveEnabled)).map((r) => r.id));
}

async function liveAllowlisted(now = Date.now()): Promise<Set<string>> {
  if (liveSet && now - liveSet.at < LIVE_SET_TTL_MS) return liveSet.ids;
  if (!liveSetInFlight) {
    liveSetInFlight = readLiveAllowlisted()
      .then((ids) => {
        liveSet = { ids, at: now };
        return ids;
      })
      .finally(() => {
        liveSetInFlight = null;
      });
  }
  try {
    return await liveSetInFlight;
  } catch (err) {
    // fail closed: no live account routes on a failed read (and nothing is cached, so the next request retries)
    console.warn("[engine-ingress] live allowlist read failed; LIVE accounts stay on the web path", { err: String(err) });
    return new Set();
  }
}

/** Is this LIVE account switched on for the engine (broker flag + account toggle)? False when the gateway URL is unset. */
export async function engineLiveRoutesFor(accountId: string): Promise<boolean> {
  if (GATEWAY_URL === "" || !accountId) return false;
  return (await liveAllowlisted()).has(accountId);
}

/**
 * THE routing decision for the order, close and close-bulk routes: the DEMO ingress list (unchanged) OR the live
 * allowlist. A DEMO-list account never costs a read.
 */
export async function engineRoutesFor(accountId: string): Promise<boolean> {
  if (engineFillsFor(accountId)) return true;
  return engineLiveRoutesFor(accountId);
}

/** Tests only: forget the cached live set. */
export function resetLiveAllowlistCacheForTests(): void {
  liveSet = null;
  liveSetInFlight = null;
}

/** For a start-up / health line: the scope this deployment is actually running with. */
export function engineIngressScope(): { enabled: boolean; accounts: number } {
  return { enabled: GATEWAY_URL !== "" && ACCOUNTS.length > 0, accounts: ACCOUNTS.length };
}

/** The gateway host this deployment would call ("" when unset or not a URL); never the path or a query. */
export function engineIngressGatewayHost(): string {
  try {
    return GATEWAY_URL ? new URL(GATEWAY_URL).host : "";
  } catch {
    return "";
  }
}

const TIMEOUT_MS = 10_000;

/**
 * The trader's own session token for the gateway: the cookie (terminal, WebTrader) OR the bearer header (the
 * QoreTrader app: its origin never gets the cookie), the same two getAccountSession accepts. Reading only the
 * cookie sent every app order down the web path in silence (2026-11-12: six MOBILE orders of the designated
 * account never reached the gateway). A missing token is logged: the caller then stays on the web path.
 */
async function sessionToken(accountId: string): Promise<string | null> {
  const token =
    (await cookies()).get(ACCOUNT_SESSION_COOKIE_NAME)?.value || bearerToken((await headers()).get("authorization"));
  if (!token) {
    console.warn("[engine-ingress] no session token on a designated account's request; staying on the web path", { accountId });
    return null;
  }
  return token;
}

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
  body: { symbol?: unknown; side?: unknown; volume?: unknown; type?: unknown } | null,
  session: { accountId: string; brokerId: string }
): Promise<NextResponse | null> {
  // only MARKET: the gateway's /market route is what this talks to, and a resting LIMIT/STOP belongs
  // to the web's own trigger path either way
  if (!body || body.type !== "MARKET") return null;
  if (typeof body.symbol !== "string" || (body.side !== "BUY" && body.side !== "SELL")) return null;

  // the trader's own session, forwarded: the gateway authenticates the ORDER, not this service
  const token = await sessionToken(session.accountId);
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
      body: JSON.stringify({ symbol: body.symbol, side: body.side, volume: String(body.volume) }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    // network failure or timeout: AMBIGUOUS, so do not fill again here
    console.error("[engine-ingress] gateway unreachable or timed out", err);
    return NextResponse.json({ error: "EXECUTION_UNAVAILABLE" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (upstream.status === 403 || upstream.status === 503) {
    // refused before writing -- carry on with this route's own path
    return null;
  }
  const data = (await upstream.json().catch(() => null)) as { order_id?: string; position_id?: string } | null;
  if (!upstream.ok || !data?.position_id || !data?.order_id) {
    console.error("[engine-ingress] unexpected answer", { status: upstream.status, data });
    return NextResponse.json({ error: "EXECUTION_UNAVAILABLE" }, { status: 502 });
  }

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

// ---- CLOSES (owner 2026-11-12): the same designated accounts, the mirror of the open path ----------------------
//
// A designated account's trader close goes to the gateway -> engine: one position to /v1/positions/:id/close, a
// basket to /v1/positions/close-bulk (the engine's one-call basket). Every other account never gets here.
//
// THE FALLBACK IS WIDER THAN THE OPEN PATH'S, AND SAFE, FOR ONE REASON: A CLOSE CANNOT BE DOUBLED. The engine's
// close_position_full and the web's closePositionInTx both close with a compare-and-set UPDATE
// (status = OPEN AND volume = expected), and the web path re-reads the position (or re-selects the basket from the
// account's OPEN positions) before it closes anything. So after ANY failure here -- a refusal (403 / 503 / 400), a
// 5xx, a timeout, the gateway unreachable -- the web path closes only what is still open: a position the engine
// already closed is refused there as "already closed" instead of being closed again. An open has no such guard,
// which is why fillThroughEngine must not fall back on an ambiguous failure and these may.
//
// A 409 is the one answer passed through as it is: the position is already closed / its close is pending with the
// dealer / this idempotency key was already answered -- a true answer about the position, and the web path would
// only say the same thing.

type GatewayAnswer = { status: number; data: unknown } | null;

/** POST to the gateway with the trader's session; null when there is no token or no answer (timeout, network). */
async function postToGateway(
  path: string,
  payload: unknown,
  session: { accountId: string; brokerId: string }
): Promise<GatewayAnswer> {
  const token = await sessionToken(session.accountId);
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${token}`,
        "x-broker-id": session.brokerId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
    });
    return { status: upstream.status, data: await upstream.json().catch(() => null) };
  } catch (err) {
    console.warn("[engine-ingress] gateway unreachable or timed out; the web path closes what is still open", {
      path,
      err: String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The engine's answer as the route's response, or null = carry on with the web path (see above). */
function closeAnswer(path: string, answer: GatewayAnswer): NextResponse | null {
  if (!answer) return null;
  if (answer.status >= 200 && answer.status < 300 && answer.data && typeof answer.data === "object") {
    return NextResponse.json(toClientShape({ ...(answer.data as object), executedBy: "engine" }), { status: 200 });
  }
  if (answer.status === 409) {
    return NextResponse.json(answer.data ?? { error: "position was already closed" }, { status: 409 });
  }
  console.warn("[engine-ingress] gateway did not close; the web path closes what is still open", {
    path,
    status: answer.status,
    data: answer.data,
  });
  return null;
}

/** A FULL close of one position (the engine's close takes no volume: a partial close stays on the web path). */
export async function closeThroughEngine(
  positionId: string,
  ask: { closePrice: string; maxSlippagePips?: unknown; maxSlippagePoints?: unknown; idempotencyKey?: unknown },
  session: { accountId: string; brokerId: string }
): Promise<NextResponse | null> {
  const path = `/v1/positions/${encodeURIComponent(positionId)}/close`;
  const payload = {
    closePrice: ask.closePrice,
    ...(ask.maxSlippagePips != null ? { maxSlippagePips: String(ask.maxSlippagePips) } : {}),
    ...(ask.maxSlippagePoints != null ? { maxSlippagePoints: String(ask.maxSlippagePoints) } : {}),
    ...(typeof ask.idempotencyKey === "string" && ask.idempotencyKey !== "" ? { idempotencyKey: ask.idempotencyKey } : {}),
  };
  return closeAnswer(path, await postToGateway(path, payload, session));
}

/** A basket, in the web close-bulk's own scope vocabulary (the gateway's closeBulkSchema is its port). */
export async function closeBulkThroughEngine(
  ask: { scope: string; symbol?: string; side?: "BUY" | "SELL"; positionIds?: string[]; idempotencyKey?: unknown },
  session: { accountId: string; brokerId: string }
): Promise<NextResponse | null> {
  const path = "/v1/positions/close-bulk";
  const payload = {
    scope: ask.scope,
    ...(ask.symbol ? { symbol: ask.symbol } : {}),
    ...(ask.side ? { side: ask.side } : {}),
    ...(ask.positionIds ? { positionIds: ask.positionIds } : {}),
    ...(typeof ask.idempotencyKey === "string" && ask.idempotencyKey !== "" ? { idempotencyKey: ask.idempotencyKey } : {}),
  };
  return closeAnswer(path, await postToGateway(path, payload, session));
}
