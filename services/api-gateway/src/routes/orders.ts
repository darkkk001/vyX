// POST /v1/orders/market — forwards to the Rust Trading Core's HTTP
// server (engine/server), per docs/api.md §2. Session-authenticated, then
// passed straight through: the Gateway does NOT yet look up the caller's
// account/symbol data in Postgres (equity, used margin, contract size,
// current price) — those come from the request body as-is. That lookup
// is the next real piece of work, not implemented here yet; see the
// comment on PlaceMarketOrderBody below and docs/trading-engine.md's
// implementation-status note for the full picture of what's missing.

import { Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireTraderSession } from "../auth.js";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";

interface PlaceMarketOrderBody {
  symbol: string;
  side: "BUY" | "SELL";
  volume: string;
  sl_price?: string;
  tp_price?: string;
  // TODO(next): fetch these from Postgres (Account.leverage/balance/credit,
  // Symbol.contractSize, LivePrice) instead of trusting the caller for
  // them — flagged, not silently assumed correct.
  equity: string;
  used_margin: string;
  contract_size: string;
  leverage: number;
  current_tick: { symbol: string; bid: string; ask: string };
}

router.post("/market", requireTraderSession, async (req: AuthedRequest, res) => {
  const body = req.body as Partial<PlaceMarketOrderBody>;
  if (!body.symbol || !body.side || !body.volume || !body.current_tick) {
    res.status(400).json({ error: "missing required order fields" });
    return;
  }

  const session = req.session!;
  const brokerId = req.headers["x-broker-id"] as string;

  const payload = {
    broker_id: brokerId,
    account_id: session.accountId,
    ...body,
  };

  const upstream = await fetch(`${TRADING_CORE_URL}/v1/orders/market`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await upstream.json();
  res.status(upstream.status).json(data);
});

export default router;
