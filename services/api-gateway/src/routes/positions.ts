// POST /v1/positions/:id/modify — edits an open position's SL/TP.
// POST /v1/positions/:id/close  — closes an open position (see that route's own comment).
//
// Both mirror orders.ts's shape and forward to engine/server; /modify goes to
// order_management::modify_position_sl_tp, which already rejects with NotFound if the position's own
// account_id doesn't match what this Gateway sends.

import { Router } from "express";
import { Decimal } from "decimal.js";
import type { AuthedRequest } from "../auth.js";
import { requireTraderSession } from "../auth.js";
import { rateLimitOrders } from "../rate-limit.js";
import { getAccount, getCloseResultView, getFreshPrice, getPositionForClose, query, writeAuditLog } from "../db.js";
import { parseUpstreamJson } from "../http.js";
import { closePositionSchema, modifyPositionSchema, validateBody } from "../validation.js";
import { engineIngressVerdict } from "./orders.js";
import { clientAsk, clientBid, loadAskRules } from "../client-ask.js";
import { effectiveCapPoints, slippageVerdict, symbolSlippageCapPoints, traderSlippagePoints } from "../slippage.js";
import type { z } from "zod";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

type ModifyPositionBody = z.infer<typeof modifyPositionSchema>;
type ClosePositionBody = z.infer<typeof closePositionSchema>;

router.post(
  "/:id/modify",
  requireTraderSession,
  rateLimitOrders(30, 60),
  validateBody(modifyPositionSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as ModifyPositionBody;
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

    const payload = {
      account_id: session.accountId,
      current_price: body.current_price,
      sl_price: body.sl_price,
      tp_price: body.tp_price,
    };

    const positionId = req.params.id as string;
    const upstream = await fetch(`${TRADING_CORE_URL}/v1/positions/${encodeURIComponent(positionId)}/modify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
      body: JSON.stringify(payload),
    });

    const data = await parseUpstreamJson(upstream);
    if (upstream.ok) {
      await writeAuditLog({
        brokerId,
        action: "GATEWAY_POSITION_MODIFIED",
        entityType: "Position",
        entityId: positionId,
        newValue: { accountId: session.accountId, slPrice: body.sl_price, tpPrice: body.tp_price, result: data },
      }).catch((err) => console.error("audit log write failed", err));
    }
    res.status(upstream.status).json(data);
  }
);

// ---- POST /v1/positions/:id/close ---------------------------------------------------------------
//
// The trader-initiated close, through the engine instead of the web's own fill path. THE ENGINE OWNS
// THE MONEY: order_management::close_position -> book::close_position_full writes the guarded
// "Position" UPDATE, the realized P&L, the TRADE_PNL ledger row, the OUT "Deal" and the
// PostCloseEffect row carrying the mirror and coverage follow-ups, all in ONE transaction. Nothing
// about the money is recomputed here.
//
// WHAT THIS ROUTE ADDS, and why each piece is here and not there:
//
//   1. THE INGRESS SCOPE. The engine's close route does NOT check it. `place_market_order` calls both
//      `ingress::allows` and `ingress::mode_allowed`; `close_position` calls neither -- so the engine's
//      own /v1/positions/{id}/close will close a position for ANY account, LIVE included, for anything
//      holding the internal secret. Until that asymmetry is fixed in the engine, this is the only check
//      standing there, so it runs before anything else touches a position.
//   2. OWNERSHIP. The position is loaded scoped to the session's account AND broker, so someone else's
//      position id answers 404 and cannot be used to probe.
//   3. THE PRICE. The engine's route takes bid/ask from its caller ("this route doesn't have its own
//      Market Data Core dependency"), so the fresh tick is read here: 15 s, on `tickAt`, the same rule
//      as the rest of this service. No fresh tick = no close, never a stale one.
//   4. THE SLIPPAGE CAP, ported in ../slippage.ts from the web's lib/slippage-cap.ts so this route
//      refuses exactly what the web's close route refuses.
//
// IDEMPOTENCY -- read this before "adding a key". A direct close has no key-based dedupe HERE OR IN THE
// WEB: the web's close route uses `idempotencyKey` only on its dealer-queue branch, where
// queueCloseInTx writes an "Order" row and UNIQUE (accountId, idempotencyKey) applies. A demo account
// never takes that branch. What prevents a double close is the engine's COMPARE-AND-SET:
// close_position_full's UPDATE requires `status = OPEN AND volume = expected`, so a second attempt
// matches no row and comes back AlreadyClosed / InvalidStatus -> 409. That is stronger than a key for
// the double-close case and weaker for a LOST ANSWER: the caller cannot ask "did my close land?" by
// key. Closing that gap needs a unique constraint on a close artifact -- a migration -- so it is
// deliberately not in this piece.
// CLOSES DO NOT SHARE THE OPENS' BUDGET.
//
// Both routes used to call rateLimitOrders(30, 60), which keys on `order:<accountId>` -- so 30 was the
// combined allowance for opening AND closing. A terminal that opens a basket and then closes it spends
// the budget twice over: 16 opens followed by 15 closes is 31 requests, and the 31st was refused. Being
// unable to CLOSE is the one refusal a trading client must never meet, because the trader is trying to
// get OUT of risk; a refused open is an inconvenience, a refused close is an unhedged position.
//
// So closes get their own bucket with a budget set high enough that no honest client reaches it
// (600/minute = 10/s sustained, against a bulk close of a few dozen positions). It is deliberately not
// "unlimited": a runaway client retrying one close forever still gets stopped, and the 429 is now
// counted and logged so we would see it. Opens keep 30/60s, untouched.
const CLOSE_RATE_LIMIT_PER_MINUTE = 600;

router.post(
  "/:id/close",
  requireTraderSession,
  rateLimitOrders(CLOSE_RATE_LIMIT_PER_MINUTE, 60, "close"),
  validateBody(closePositionSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as ClosePositionBody;
    const session = req.session!;
    const brokerId = req.headers["x-broker-id"] as string;
    const positionId = req.params.id as string;

    // CLOSE-PATH TIMING -- the counterpart to the market route's [order-timing] (routes/orders.ts).
    //
    // Hooked on res "finish" rather than appended before each res.json: this handler has nine distinct
    // exit paths (404, 403, 403, 404, 409, 409, 400, 400, 502, 200, 200), and one log line per exit would
    // silently miss whichever branch someone adds next. "finish" fires exactly once per answered request,
    // whichever branch answered it, so the measurement cannot drift away from the code.
    //
    // `route=` goes on BOTH lines (this one and the market route's). Without it the two are
    // indistinguishable in gateway.log -- which is precisely why close latency could not be measured
    // before, even though the file was full of [order-timing] lines. `status=` is here for the same
    // reason: a 150 ms refusal and a 150 ms fill are not the same measurement.
    const t0 = Date.now();
    let tMark = t0;
    const stage: string[] = [];
    const mark = (name: string) => {
      const now = Date.now();
      stage.push(`${name}=${now - tMark}ms`);
      tMark = now;
    };
    res.on("finish", () => {
      console.log(
        `[order-timing] route=close status=${res.statusCode} total=${Date.now() - t0}ms ${stage.join(" ")}`
      );
    });

    const account = await getAccount(session.accountId, brokerId);
    if (!account) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (account.status !== "ACTIVE") {
      res.status(403).json({ error: "account is not active" });
      return;
    }

    // (1) the scope the engine's close route does not enforce
    const ingress = engineIngressVerdict(session.accountId, account.accountMode);
    if (!ingress.ok) {
      res.status(403).json({ error: ingress.why });
      return;
    }

    // (2) ownership + state
    const position = await getPositionForClose(positionId, session.accountId, brokerId);
    mark("position");
    if (!position) {
      res.status(404).json({ error: "position not found" });
      return;
    }
    if (position.status !== "OPEN") {
      // the web answers this exact string for the same case and the client keys off it
      res.status(409).json({ error: "position was already closed" });
      return;
    }
    if (position.closePendingOrderId) {
      res.status(409).json({ error: "CLOSE_PENDING", orderId: position.closePendingOrderId });
      return;
    }

    // (3) the fresh tick
    const price = await getFreshPrice(position.symbolName);
    mark("price");
    if (!price) {
      res.status(400).json({ error: "NO_LIVE_FEED", symbol: position.symbolName });
      return;
    }
    // THE PRICE A BOOK POSITION CLOSES AT IS THE ACCOUNT'S, NOT THE RAW TICK.
    //
    // This was wrong in the first cut of this route: it used the raw bid/ask. `calc::close_price_for`
    // (raw) is the LEGACY engine-table path and its own doc comment says so; a position on Prisma's book
    // closes at `calc::position_close_price`, which applies the account's SYMMETRIC markup -- a BUY at
    // the account's bid, a SELL at the account's ask (owner decision 2026-10-29). And the bid is NOT
    // passed through raw: `account_bid` subtracts half the markup, so a raw comparison is off on BOTH
    // sides whenever a markup or target rule is in force, not just on a SELL.
    //
    // clientBid / clientAsk here are this service's existing port of that same rule (client-ask.ts,
    // mirroring lib/ask-markup.ts and the engine's ask_markup.rs) -- same halves, same rounding
    // direction, same floor. RAW bid/ask still go to the engine below, because the engine applies the
    // rule itself; the marked price is needed only to compare the client's reference against the fill
    // the engine will actually produce.
    const rules = await loadAskRules(query, [session.accountId], brokerId);
    const rule = rules.get(session.accountId)?.get(position.symbolName) ?? {
      mode: "markup" as const,
      markupPips: new Decimal(0),
      digits: position.digits,
    };
    const closePrice =
      position.side === "BUY" ? clientBid(rule, price.bid, price.ask) : clientAsk(rule, price.bid, price.ask);

    // (4) slippage, only when the client sent its own reference. The cap is the broker's (this symbol's
    // own value, else the XAU base scaled to this symbol's price); the trader's value can only tighten
    // it. A close of a BUY position SELLS, so worse means lower -- hence the flipped side.
    if (body.closePrice != null) {
      const capPoints = effectiveCapPoints(
        traderSlippagePoints(body, position.digits),
        symbolSlippageCapPoints(
          { slippageCapXauPoints: position.brokerCapXauPoints, slippageCapRefPrice: position.brokerCapRefPrice },
          { name: position.symbolName, digits: position.digits, maxSlippagePoints: position.symbolCapPoints },
          closePrice
        )
      );
      const closeSide = position.side === "BUY" ? "SELL" : "BUY";
      const overCapAt = (fill: Decimal) =>
        slippageVerdict({ side: closeSide, requested: new Decimal(body.closePrice!), fill, digits: position.digits, capPoints }).over;
      // The web's own rule, kept verbatim: a SELL's reference may be the RAW ask (a client from before
      // the account-ask change of 2026-09-26) or the account's ask, and the markup is not market
      // movement -- so the close is refused only when the reference is off BOTH.
      const over =
        overCapAt(closePrice) &&
        !(position.side === "SELL" && !closePrice.equals(price.ask) && !overCapAt(price.ask));
      if (over) {
        res.status(400).json({ error: "SLIPPAGE_EXCEEDED", serverPrice: closePrice.toString() });
        return;
      }
    }

    // (5) the engine does the close
    const upstream = await fetch(`${TRADING_CORE_URL}/v1/positions/${encodeURIComponent(positionId)}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
      // idempotency_key is FORWARDED, not just accepted. It was missing in the first cut of this route,
      // written when the engine's close had no key parameter -- so the key was validated here, written to
      // the audit row, and then dropped. The smoke caught it: a replayed key closed a SECOND position
      // instead of answering 409, which is precisely the failure the key exists to prevent. The engine
      // stamps it on the close's TRADE_PNL row, where UNIQUE (accountId, idempotencyKey) refuses a replay.
      body: JSON.stringify({
        account_id: session.accountId,
        bid: price.bid.toString(),
        ask: price.ask.toString(),
        idempotency_key: body.idempotencyKey ?? null,
      }),
    });
    const upstreamData = await parseUpstreamJson(upstream);
    if (!upstream.ok) {
      // A 404 FROM THE ENGINE IS NOT THE CLIENT'S 404, and passing it through says something false.
      //
      // We read this position off Prisma's "Position" two steps ago, so it exists. The engine's close
      // route looks it up with `db::get_position`, which reads the LEGACY lowercase `positions` table --
      // empty in production (0 rows, verified 2026-11-04) because every broker's book is Prisma's.
      // So the engine answers NotFound for every real position, with the same wording this route uses
      // for "not yours", which is exactly what made the first diagnosis of this slow.
      //
      // Until the engine exposes `book::close_position_full` (its real Prisma-book close, today reachable
      // only from the risk fires) on this route, a 404 here means THE ENGINE CANNOT CLOSE, not that the
      // position is missing. Say that instead of telling a trader their open position does not exist.
      if (upstream.status === 404) {
        console.error("[close] engine answered 404 for a position that exists on the Prisma book", {
          positionId,
          hint: "engine close route reads the legacy `positions` table; it needs close_position_full",
        });
        res.status(502).json({ error: "EXECUTION_UNAVAILABLE" });
        return;
      }
      // InvalidStatus / AlreadyClosed (409) are genuine answers about this position, so they pass through
      res.status(upstream.status).json(upstreamData);
      return;
    }

    // (6) the answer the UI already handles: the closed Position, its ledger row, the new balance. Read
    // back, because the engine returns only {close_price, realized_pnl} and the client needs the rest.
    mark("engine");
    const view = await getCloseResultView(positionId, session.accountId);
    mark("readback");

    await writeAuditLog({
      brokerId,
      action: "GATEWAY_POSITION_CLOSED",
      entityType: "Position",
      entityId: positionId,
      newValue: {
        accountId: session.accountId,
        symbol: position.symbolName,
        side: position.side,
        volume: position.volume.toString(),
        clientReferencePrice: body.closePrice ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
        engine: upstreamData,
      },
    }).catch((err) => console.error("audit log write failed", err));

    if (!view) {
      // the engine committed and only the read-back failed: answer with what the engine returned rather
      // than a 500. The close DID happen, and telling the client otherwise is the worse error.
      res.status(200).json({ ...(upstreamData as object), partial: false });
      return;
    }
    res.status(200).json({ position: view.position, transaction: view.transaction, partial: false, balance: view.balance });
  }
);

export default router;
