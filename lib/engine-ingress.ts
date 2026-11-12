import "server-only";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME } from "@/lib/account-auth";
import { bearerToken } from "@/lib/app-web";
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

  // the trader's own session, forwarded: the gateway authenticates the ORDER, not this service.
  // The cookie (terminal, WebTrader) OR the bearer header (the QoreTrader app: its origin never gets the
  // cookie), the same two getAccountSession accepts. Reading only the cookie sent every app order down the
  // web path in silence (2026-11-12: six MOBILE orders of the designated account never reached the gateway).
  const token =
    (await cookies()).get(ACCOUNT_SESSION_COOKIE_NAME)?.value || bearerToken((await headers()).get("authorization"));
  if (!token) {
    console.warn("[engine-ingress] no session token on a designated account's order; filling on the web path", {
      accountId: session.accountId,
    });
    return null;
  }

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
