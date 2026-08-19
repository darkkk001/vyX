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
import { getAccount, getLedgerSum, getOpenPositionsSummary, getSymbolContractSize, writeAuditLog } from "../db.js";
import { parseUpstreamJson } from "../http.js";
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

type PlaceMarketOrderBody = z.infer<typeof placeMarketOrderSchema>;

router.post(
  "/market",
  requireTraderSession,
  rateLimitOrders(30, 60),
  validateBody(placeMarketOrderSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as PlaceMarketOrderBody;

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

    const contractSize = await getSymbolContractSize(body.symbol);
    if (!contractSize) {
      res.status(400).json({ error: `unknown symbol: ${body.symbol}` });
      return;
    }

    const { usedMargin, floatingPnl } = await getOpenPositionsSummary(session.accountId, account.leverage);
    const ledgerSum = await getLedgerSum(session.accountId);
    const effectiveBalance = account.balance.plus(ledgerSum);
    const equity = effectiveBalance.plus(account.credit).plus(floatingPnl);

    const payload = {
      broker_id: brokerId,
      account_id: session.accountId,
      symbol: body.symbol,
      side: body.side,
      volume: body.volume,
      sl_price: body.sl_price,
      tp_price: body.tp_price,
      equity: equity.toString(),
      used_margin: usedMargin.toString(),
      contract_size: contractSize.toString(),
      leverage: account.leverage,
    };

    const upstream = await fetch(`${TRADING_CORE_URL}/v1/orders/market`, {
      method: "POST",
      headers: tradingCoreHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await parseUpstreamJson(upstream);
    if (upstream.ok) {
      await writeAuditLog({
        brokerId,
        action: "GATEWAY_ORDER_PLACED",
        entityType: "Order",
        entityId: (data.order_id as string | undefined) ?? (data.position_id as string | undefined) ?? session.accountId,
        newValue: { accountId: session.accountId, symbol: body.symbol, side: body.side, volume: body.volume, result: data },
      }).catch((err) => console.error("audit log write failed", err));
    }
    res.status(upstream.status).json(data);
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
  rateLimitOrders(30, 60),
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
router.post("/:id/cancel", requireTraderSession, rateLimitOrders(30, 60), async (req: AuthedRequest, res) => {
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
