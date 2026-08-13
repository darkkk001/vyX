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
import { Decimal } from "decimal.js";
import type { AuthedRequest } from "../auth.js";
import { requireTraderSession } from "../auth.js";
import { getAccount, getLedgerSum, getOpenPositionsSummary, getSymbolContractSize } from "../db.js";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";

interface PlaceMarketOrderBody {
  symbol: string;
  side: "BUY" | "SELL";
  volume: string;
  sl_price?: string;
  tp_price?: string;
}

router.post("/market", requireTraderSession, async (req: AuthedRequest, res) => {
  const body = req.body as Partial<PlaceMarketOrderBody>;
  if (!body.symbol || !body.side || !body.volume) {
    res.status(400).json({ error: "missing required order fields: symbol, side, volume" });
    return;
  }
  if (!new Decimal(body.volume).isPositive()) {
    res.status(400).json({ error: "volume must be positive" });
    return;
  }

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await upstream.json();
  res.status(upstream.status).json(data);
});

export default router;
