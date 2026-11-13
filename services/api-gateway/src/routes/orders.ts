// POST /v1/orders/market — forwards to the Rust Trading Core's HTTP
// server (engine/server), per docs/api.md §2.
//
// Every risk-check input (equity, used margin, contract size) is fetched
// here from Postgres, never trusted from the request body — a client can
// only say "which symbol, which side, how much," nothing that would let
// it fake its own margin. This closes the gap flagged in
// docs/api.md/architecture.md's original skeleton.
//
// The current tick is deliberately NOT fetched or forwarded here anymore
// — OMS (engine/order-management::place_market_order) now reads Market
// Data Core's live price itself, per docs/execution.md §2.1's "never the
// client-supplied price" (where "client" meant this Gateway too, not
// just the end user's browser). This Gateway was already reading the
// real Postgres value, not something the browser could fake, but routing
// the fill price through one fewer hop closes the staleness window
// between "Gateway fetched it" and "OMS actually fills" and matches the
// documented target architecture exactly.

import { Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireTraderSession } from "../auth.js";
import { rateLimitOrders } from "../rate-limit.js";
import { getAccount, getAccountAndContractSize, getFreshPrice, getOpenSlippageInputs, getSymbolContractSize, query, writeAuditLog } from "../db.js";
import { parseUpstreamJson } from "../http.js";
import { Decimal } from "decimal.js";
import { clientAsk, clientBid, loadAskRules } from "../client-ask.js";
import { effectiveCapPoints, slippageVerdict, symbolSlippageCapPoints, traderSlippagePoints } from "../slippage.js";
import { recordOrderAckLatency } from "../ws.js";
import { placeMarketOrderSchema, placePendingOrderSchema, validateBody } from "../validation.js";
import type { z } from "zod";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
// Only this Gateway should hold this value -- see engine/server's own
// require_internal_secret doc comment (main.rs). Distinct from
// PRICE_FEED_SECRET, which gates the MT5 ingest route instead.
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

function tradingCoreHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET };
}
// ---- L2 Step 3: WHICH ACCOUNTS MAY REACH THE ENGINE (owner 2026-11-03) ----
//
// The cutover's first live exposure is ONE designated DEMO account. Everything else keeps filling on
// the web and must be UNABLE to reach the engine, not merely unlikely to.
//
// FAIL CLOSED: an unset or empty variable allows NOBODY. That is the opposite of the usual
// "unconfigured = unrestricted" default, and it is the point -- a deploy that forgets the variable
// turns the engine ingress OFF, it does not open it to every account.
//
// TWO conditions, both required, because they fail differently:
//   1. the account is on the list -- the deliberate, per-account opt-in;
//   2. the account is `accountMode = DEMO` as the DATABASE says -- so a LIVE account id typed into the
//      list by mistake is still refused. The list is a human artefact; this check is not.
//
// The engine repeats both itself (order_management::ingress): its own /v1/orders/market is reachable
// by anything holding the internal secret, so this gateway must not be the only thing standing there.
const ENGINE_INGRESS_ACCOUNT_IDS = (process.env.ENGINE_INGRESS_ACCOUNT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type IngressVerdict = { ok: true } | { ok: false; why: string };

// LIVE CUTOVER (owner 2026-11-11, DORMANT -- docs/ENGINE-LIVE-ALLOWLIST.md). The one rule, shared by
// the web (lib/risk-authority.ts engineLiveAllowed) and the engine (ingress::engine_live_allowed), and
// pinned for all three by lib/engine-live-allowlist-cases.json.
//
// THREE conditions, all required: the account is LIVE, its broker's flag is on, and its own entry is
// on. Anything missing, null, unknown or false is NOT allowed. Both columns default false in the
// database, so this is false for every account today.
//
// The two flags are COLUMNS read in the same query as `accountMode` (src/db.ts) -- never an env list,
// never a cache older than the request. The env list above keeps its old meaning, the trial SCOPE, and
// on its own it still cannot admit a LIVE account: that was the L2 Step 3 finding, where a live id was
// put on the list and filled because the list was the only condition.
export function engineLiveAllowed(accountMode: string, allowlistOn: boolean, engineLiveEnabled: boolean): boolean {
  return accountMode === "LIVE" && allowlistOn === true && engineLiveEnabled === true;
}

export function engineIngressVerdict(
  accountId: string,
  accountMode: string,
  allowList: string[] = ENGINE_INGRESS_ACCOUNT_IDS,
  allowlistOn = false,
  engineLiveEnabled = false
): IngressVerdict {
  if (allowList.length === 0) return { ok: false, why: "the engine order path is not enabled here" };
  // THE SCOPE IS THE LIST **OR** WHAT THE COLUMNS ADMIT (owner 2026-11-13). An allowlisted LIVE account
  // is in scope without also having to be pasted into ENGINE_INGRESS_ACCOUNT_IDS -- that list stays the
  // DEMO trial scope and is not where live accounts are enrolled.
  //
  // DORMANT BY CONSTRUCTION: engineLiveAllowed is false for every account while the two columns are
  // false, so this reads exactly as `!allowList.includes(accountId)` did, for every account in the
  // database today.
  if (!allowList.includes(accountId) && !engineLiveAllowed(accountMode, allowlistOn, engineLiveEnabled)) {
    return { ok: false, why: "this account is not served by the engine order path" };
  }
  // the defaults above are false, so a caller that passes neither flag gets exactly the old rule.
  // Kept SEPARATE from the scope check above on purpose: a LIVE id someone pastes into the env list is
  // in scope by that paste, and this is what still refuses it -- the L2 Step 3 finding.
  if (accountMode !== "DEMO" && !engineLiveAllowed(accountMode, allowlistOn, engineLiveEnabled)) {
    return { ok: false, why: "the engine order path serves DEMO accounts only" };
  }
  return { ok: true };
}


// PRIORITY 1 (FAILOVER): "is the engine able to fill an order right now?", answerable from Vercel.
//
// The web guard has to decide whether to forward an order BEFORE it forwards it, and until now it had
// no way to ask. The obvious candidate was the heartbeat row the engine writes ("RiskEngineHeartbeat",
// which lib/risk-owner.ts already reads), and it is the WRONG SIGNAL for this -- measured, not
// supposed. The engine's idle gate deliberately skips that timer when the book cannot move:
//
//   idle gate: skipping until the book can move timer="risk heartbeat" reason="book closed (no fresh
//   tick on any symbol the book holds)"
//
// So on a closed market, or during any feed-quiet stretch longer than staleAfterSecs, the heartbeat
// goes stale while the engine is perfectly healthy and answering. Gating the order path on it would
// turn the ingress off every weekend and flap it on every quiet patch mid-session. The heartbeat
// answers "can the book move", which is a different question from "is the order path up".
//
// This endpoint answers the actual question, from the one place that can: the gateway shares a
// loopback with the engine, so its probe is sub-millisecond and needs no database at all.
//
// WHAT IT DOES NOT TELL YOU, on purpose. It says the engine process is up and answering, nothing more.
// It does NOT promise the engine will accept the next order -- an unloaded thresholds guard still
// answers 503 per order, and the account scoping still applies -- because a health endpoint that tried
// to pre-judge a specific order would have to take that order's inputs, and would then be an order
// route with extra steps. The guard treats this as "worth trying", and the real verdict stays with the
// order itself.
//
// Unauthenticated, like the gateway's own /health, and deliberately uninformative: one boolean. The
// engine's commit header is not forwarded.
router.get("/engine-health", async (_req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const upstream = await fetch(`${TRADING_CORE_URL}/health`, { signal: controller.signal });
    if (!upstream.ok) {
      res.status(503).json({ ok: false });
      return;
    }
    res.json({ ok: true });
  } catch {
    // unreachable or slower than a loopback call has any business being
    res.status(503).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
});

type PlaceMarketOrderBody = z.infer<typeof placeMarketOrderSchema>;

// owner 2026-11-10: 30 a minute refused normal rapid manual trading (~20-25 orders plus cancels in a minute). Market, pending and
// cancel share one budget; 600 a minute matches the web order route (lib/order-rate-limit.ts) and this service's own close / modify.
const ORDER_RATE_LIMIT_PER_MINUTE = 600;

router.post(
  "/market",
  requireTraderSession,
  rateLimitOrders(ORDER_RATE_LIMIT_PER_MINUTE, 60),
  validateBody(placeMarketOrderSchema),
  async (req: AuthedRequest, res) => {
    // L2 Step 5: per-stage timing. The gateway added ~80 ms on top of a 24 ms engine call, and the
    // first guess (connections being reaped) measured as no change at all -- so this says where
    // rather than asking the next person to reason about it.
    const t0 = Date.now();
    let tMark = t0;
    const stage: string[] = [];
    const mark = (name: string) => {
      const now = Date.now();
      stage.push(`${name}=${now - tMark}ms`);
      tMark = now;
    };

    const body = req.body as PlaceMarketOrderBody;

    const session = req.session!;
    const brokerId = req.headers["x-broker-id"] as string;

    // L2 optimization pass: the account and the symbol's contract size in ONE round trip
    const loaded = await getAccountAndContractSize(session.accountId, brokerId, body.symbol);
    mark("accountAndSymbol");
    if (!loaded) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    const account = loaded.account;
    if (account.status !== "ACTIVE") {
      res.status(403).json({ error: "account is not active" });
      return;
    }

    // L2 Step 3 ingress scoping: 403 and not 400 -- nothing about the request is malformed, the
    // engine simply does not serve this account, and the caller's correct answer is the web path.
    const ingress = engineIngressVerdict(session.accountId, account.accountMode, undefined, account.engineLiveAllowlistOn, account.engineLiveEnabled);
    if (!ingress.ok) {
      res.status(403).json({ error: ingress.why });
      return;
    }

    const contractSize = loaded.contractSize;
    if (!contractSize) {
      res.status(400).json({ error: `unknown symbol: ${body.symbol}` });
      return;
    }

    // ---- SLIPPAGE CAP, when the client sent its own screen price --------------------------------
    //
    // WHY THIS IS HERE AT ALL. The engine has NO slippage cap: it fills at its own tick, and before this
    // the Gateway sent no reference price, so an order through here was filled however far the market had
    // moved from what the trader saw. The web's market route has refused that since 2026-10-26
    // (lib/slippage-cap.ts). This closes that gap with the SAME configuration -- the broker's XAU base
    // scaled to the symbol, its own override if set, tightened by the trader's value -- and the SAME
    // basis: the price the engine will actually fill at, which is the ACCOUNT's marked price
    // (`pricing::quoted_tick` -> a BUY at the account's ask, a SELL at its bid), not the raw tick.
    //
    // WHAT IT CANNOT DO, and this is a real gap, not a rounding of one. Over the cap the web either
    // REQUOTES (writes a REQUOTED "Order" the client answers via /api/trade/orders/:id/requote-response)
    // or REJECTS, per `Broker.slippageAction` -- and EVERY broker is set to REQUOTE. Writing a REQUOTED
    // order is a book write this service does not do and the engine has no path for, so the requote
    // STATE MACHINE stays on the web. What this does is refuse to fill at a price outside the cap and say
    // so, carrying the same detail the web records, plus `requoteRequired` so a client can fall back to
    // the web path for the offer. Strictly safer than today (fill at any distance), strictly less than
    // the web (no offer). Closing it needs the engine to write a REQUOTED order.
    if (body.price != null) {
      const slip = await getOpenSlippageInputs(brokerId, body.symbol);
      const tick = await getFreshPrice(body.symbol);
      if (slip && tick) {
        const rules = await loadAskRules(query, [session.accountId], brokerId);
        const rule = rules.get(session.accountId)?.get(body.symbol) ?? {
          mode: "markup" as const,
          markupPips: new Decimal(0),
          digits: slip.digits,
        };
        // the side the engine fills at: a BUY buys at the account's ask, a SELL sells at its bid
        const fill = body.side === "BUY" ? clientAsk(rule, tick.bid, tick.ask) : clientBid(rule, tick.bid, tick.ask);
        // the cap's own reference is the RAW side price, as the web passes it
        const capRef = body.side === "BUY" ? tick.ask : tick.bid;
        const capPoints = effectiveCapPoints(
          traderSlippagePoints(body, slip.digits),
          symbolSlippageCapPoints(
            { slippageCapXauPoints: slip.brokerCapXauPoints, slippageCapRefPrice: slip.brokerCapRefPrice },
            { name: body.symbol, digits: slip.digits, maxSlippagePoints: slip.symbolCapPoints },
            capRef
          )
        );
        const verdict = slippageVerdict({
          side: body.side,
          requested: new Decimal(body.price),
          fill,
          digits: slip.digits,
          capPoints,
        });
        if (verdict.over) {
          res.status(400).json({
            error: "SLIPPAGE_EXCEEDED",
            serverPrice: fill.toString(),
            requestedPrice: body.price,
            livePrice: capRef.toString(),
            adversePoints: verdict.adversePoints.toString(),
            capPoints: verdict.capPoints.toString(),
            // the web would REQUOTE for every broker configured today; this service cannot write that
            // order, so the client has to take the offer from the web path
            requoteRequired: slip.slippageAction !== "REJECT",
          });
          return;
        }
      }
    }

    // L2 Step 5 (latency): equity and used margin are NOT computed here any more, and the two Neon
    // reads that produced them are gone.
    //
    // This file's header says every risk-check input is fetched here so a client cannot fake its own
    // margin. That was right for the design it was written in -- the engine trusted these numbers.
    // L2 Step 1d inverted it: `place_market_order` now reads the account's funds and open positions
    // from the real book itself, in one snapshot (db::get_open_snapshot), and IGNORES these fields on
    // the Prisma book entirely. Measured, not assumed: engine-direct fills sent equity "0" and
    // used_margin "0" and produced correct fills with correct margin decisions.
    //
    // So computing them cost two Neon round trips per order and changed nothing. They stay in the
    // payload as ZEROS rather than being removed, because the frozen LEGACY order mode still reads
    // them -- and zero makes that path fail CLOSED (no equity, so `check_free_margin` refuses) rather
    // than open, if anyone ever re-enables it.
    const payload = {
      broker_id: brokerId,
      account_id: session.accountId,
      symbol: body.symbol,
      side: body.side,
      volume: body.volume,
      sl_price: body.sl_price,
      tp_price: body.tp_price,
      equity: "0",
      used_margin: "0",
      contract_size: contractSize.toString(),
      leverage: account.leverage,
      // PRIORITY 1 (FAILOVER): carried, not interpreted. The engine writes it into
      // `"Order".idempotencyKey`, where `"Order"`'s UNIQUE (accountId, idempotencyKey) makes a second
      // fill of the same key impossible and the web's existing by-key read can find this one.
      idempotency_key: body.idempotencyKey,
    };

    // Phase 0 money-risk patch item 3 (docs/ROADMAP.md) -- this Gateway's
    // own definition of "order ack": the round trip to the Rust engine
    // and back, everything above (Postgres reads for margin/exposure)
    // deliberately excluded since that's this Gateway's own overhead, not
    // the execution path being measured. See ws.ts's orderAckStats.
    const upstreamStartedAt = Date.now();
    const upstream = await fetch(`${TRADING_CORE_URL}/v1/orders/market`, {
      method: "POST",
      headers: tradingCoreHeaders(),
      body: JSON.stringify(payload),
    });
    recordOrderAckLatency(Date.now() - upstreamStartedAt);
    mark("engine");

    const data = await parseUpstreamJson(upstream);
    if (upstream.ok) {
      // L2 Step 5 (latency): NOT awaited. The audit row is a record, not part of the answer -- it was
      // already best effort (its failure was caught and logged, never surfaced), so awaiting it only
      // made every order wait on a Neon write that nothing reads back. Same reasoning as the engine's
      // OrderFilled publish.
      void writeAuditLog({
        brokerId,
        action: "GATEWAY_ORDER_PLACED",
        entityType: "Order",
        entityId: (data.order_id as string | undefined) ?? (data.position_id as string | undefined) ?? session.accountId,
        newValue: { accountId: session.accountId, symbol: body.symbol, side: body.side, volume: body.volume, result: data },
      }).catch((err) => console.error("audit log write failed", err));
    }
    mark("parse");
    res.status(upstream.status).json(data);
    // route= so this line and the close route's are separable in one grep -- see routes/positions.ts.
    console.log(`[order-timing] route=market total=${Date.now() - t0}ms ${stage.join(" ")}`);
  }
);

// POST /v1/orders/pending — LIMIT/STOP orders, per docs/execution.md
// §2.1 step 3. No equity/used_margin computed or forwarded here, unlike
// /market: a pending order doesn't reserve margin while it waits — OMS
// checks margin at trigger time instead (order_management::
// pending_orders), the one place a pending order's outcome can still
// differ from what the trader saw at placement.
type PlacePendingOrderBody = z.infer<typeof placePendingOrderSchema>;

router.post(
  "/pending",
  requireTraderSession,
  rateLimitOrders(ORDER_RATE_LIMIT_PER_MINUTE, 60),
  validateBody(placePendingOrderSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as PlacePendingOrderBody;

    const session = req.session!;
    const brokerId = req.headers["x-broker-id"] as string;

    const account = await getAccount(session.accountId, brokerId);
    if (!account) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (account.status !== "ACTIVE") {
      res.status(403).json({ error: "account is not active" });
      return;
    }

    // L2 Step 3 ingress scoping: 403 and not 400 -- nothing about the request is malformed, the
    // engine simply does not serve this account, and the caller's correct answer is the web path.
    const ingress = engineIngressVerdict(session.accountId, account.accountMode, undefined, account.engineLiveAllowlistOn, account.engineLiveEnabled);
    if (!ingress.ok) {
      res.status(403).json({ error: ingress.why });
      return;
    }

    const contractSize = await getSymbolContractSize(body.symbol);
    if (!contractSize) {
      res.status(400).json({ error: `unknown symbol: ${body.symbol}` });
      return;
    }

    const payload = {
      broker_id: brokerId,
      account_id: session.accountId,
      symbol: body.symbol,
      side: body.side,
      order_type: body.order_type,
      volume: body.volume,
      requested_price: body.requested_price,
      sl_price: body.sl_price,
      tp_price: body.tp_price,
    };

    const upstream = await fetch(`${TRADING_CORE_URL}/v1/orders/pending`, {
      method: "POST",
      headers: tradingCoreHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await parseUpstreamJson(upstream);
    if (upstream.ok) {
      await writeAuditLog({
        brokerId,
        action: "GATEWAY_PENDING_ORDER_PLACED",
        entityType: "Order",
        entityId: (data.order_id as string | undefined) ?? session.accountId,
        newValue: { accountId: session.accountId, symbol: body.symbol, side: body.side, orderType: body.order_type, volume: body.volume, result: data },
      }).catch((err) => console.error("audit log write failed", err));
    }
    res.status(upstream.status).json(data);
  }
);

// POST /v1/orders/:id/cancel — cancels a still-resting LIMIT/STOP order.
// No request body needed: engine/server's cancel_order (order_management
// lib.rs) already rejects with NotFound if the order's own account_id
// doesn't match the account_id this Gateway sends, so ownership is
// enforced there, not by fetching the order here first.
router.post("/:id/cancel", requireTraderSession, rateLimitOrders(ORDER_RATE_LIMIT_PER_MINUTE, 60), async (req: AuthedRequest, res) => {
  const session = req.session!;
  const brokerId = req.headers["x-broker-id"] as string;

  const account = await getAccount(session.accountId, brokerId);
  if (!account) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  if (account.status !== "ACTIVE") {
    res.status(403).json({ error: "account is not active" });
    return;
  }

  // L2 Step 3 ingress scoping: 403 and not 400 -- nothing about the request is malformed, the
  // engine simply does not serve this account, and the caller's correct answer is the web path.
  const ingress = engineIngressVerdict(session.accountId, account.accountMode, undefined, account.engineLiveAllowlistOn, account.engineLiveEnabled);
  if (!ingress.ok) {
    res.status(403).json({ error: ingress.why });
    return;
  }

  const orderId = req.params.id as string;
  const upstream = await fetch(`${TRADING_CORE_URL}/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
    headers: tradingCoreHeaders(),
    body: JSON.stringify({ account_id: session.accountId }),
  });

  const data = await parseUpstreamJson(upstream);
  if (upstream.ok) {
    await writeAuditLog({
      brokerId,
      action: "GATEWAY_ORDER_CANCELLED",
      entityType: "Order",
      entityId: orderId,
      newValue: { accountId: session.accountId, result: data },
    }).catch((err) => console.error("audit log write failed", err));
  }
  res.status(upstream.status).json(data);
});

export default router;
