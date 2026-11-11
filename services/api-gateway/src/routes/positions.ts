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
import {
  getAccount,
  getCloseResultView,
  getFreshPrice,
  getFreshPrices,
  getOpenPositionsForBulk,
  getPositionForClose,
  query,
  writeAuditLog,
} from "../db.js";
import { parseUpstreamJson } from "../http.js";
import { closeBulkSchema, closePositionSchema, modifyPositionSchema, validateBody } from "../validation.js";
import { engineIngressVerdict } from "./orders.js";
import { clientAsk, clientBid, loadAskRules } from "../client-ask.js";
import { bulkErrorFor, selectBulkBasket, type BulkTarget, type Live } from "../bulk-select.js";
import { effectiveCapPoints, slippageVerdict, symbolSlippageCapPoints, traderSlippagePoints } from "../slippage.js";
import type { z } from "zod";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

type ModifyPositionBody = z.infer<typeof modifyPositionSchema>;
type ClosePositionBody = z.infer<typeof closePositionSchema>;
type CloseBulkBody = z.infer<typeof closeBulkSchema>;

// SL/TP EDITS DO NOT SHARE THE OPENS' BUDGET EITHER.
//
// Same defect as the close route had: this keyed `order:<accountId>` at 30/60s, so editing stops on a
// basket of positions spent the allowance that placing orders needs -- and a trader dragging an SL across
// twenty positions is making twenty requests without placing a single order. Changing protective stops is
// also risk-REDUCING work, so throttling it at the same rate as order entry has the priority backwards.
//
// Its own bucket, same generous budget as closes: enough that no real SL/TP editing reaches it, still a
// backstop against a client stuck in a modify loop.
const MODIFY_RATE_LIMIT_PER_MINUTE = 600;

router.post(
  "/:id/modify",
  requireTraderSession,
  rateLimitOrders(MODIFY_RATE_LIMIT_PER_MINUTE, 60, "modify"),
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
    const ingress = engineIngressVerdict(session.accountId, account.accountMode, undefined, account.engineLiveAllowlistOn, account.engineLiveEnabled);
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

// ---- POST /v1/positions/close-bulk -------------------------------------------------------------
//
// THE WHOLE BASKET, ONE REQUEST, ONE LOCK HOLD. The replacement for the trader terminal's bulk close,
// which today goes to Vercel (app/api/trade/positions/close-bulk -> lib/bulk-close.ts) and loops
// closePositionInTx per position inside one transaction: for a basket of 20 that is roughly 200
// sequential round trips from Vercel to Neon, which is where the measured 10-15 s comes from. Here the
// Gateway resolves the basket and hands it to the engine in ONE call, and the engine settles it with one
// `vyx_close_positions` -- one round trip, and the "Account" row lock taken once and held to COMMIT
// instead of acquired and released 20 times with gaps for other writers to interleave.
//
// WHAT THIS ROUTE OWNS and the engine does not:
//
//   1. THE SCOPE. ALL / PROFIT / LOSS / SYMBOL, plus the optional `side` filter and `positionIds`
//      narrowing -- the same vocabulary and the same semantics as the web's selectBulkCloseTargets, so a
//      client switching from that route to this one changes a URL and nothing about the body. PROFIT and
//      LOSS are classified off the SAME price snapshot the close fills at, which is the point: "close
//      profitable" has to mean what was on the trader's screen when they pressed it, not what a second
//      read says a tick later.
//   2. THE INGRESS SCOPE, because the engine's close routes do not check it (see the single close's own
//      comment on that asymmetry). Checked once for the basket, before any position is touched.
//   3. OWNERSHIP, structurally rather than by checking: the selection STARTS from this account's own
//      open positions, so `positionIds` can only remove from that set. An id belonging to someone else
//      is not refused, it is simply never in the basket -- so this route cannot be used to probe for
//      other accounts' position ids.
//   4. THE PRICE, one fresh tick per distinct symbol (15 s, on `tickAt`), marked to the account the same
//      way the single close marks it -- a BUY at the account's bid, a SELL at its ask. Every position in
//      the same symbol therefore closes at an IDENTICAL price, which the old per-position loop could not
//      promise. RAW bid/ask go to the engine, which applies the markup itself; the marked price is used
//      here only for the PROFIT/LOSS split.
//
// NO SLIPPAGE CAP HERE, deliberately -- and the web's bulk path has none either. The cap compares the
// client's own reference price against the fill, and a bulk close has no single reference to compare
// against. Giving it a per-position reference would be a new client contract, not a port of one.
//
// MARKET-CLOSED SYMBOLS READ AS "no live price" here, where the web answers MARKET_CLOSED with the next
// session open. That distinction needs the trading-session calendar (lib/risk.ts's checkTradingSession /
// computeNextSessionOpen) and this service has never had a port of it. The money is the same either way
// -- a closed symbol closes in neither route -- but the message is poorer, so this is a known gap and
// deliberately a noted one rather than a silent one.
//
// THE DEAL READS "CLIENT", NOT "BULK". The engine's close primitive hardcodes DealReason::Client, and
// the per-position fallback path goes through it, so stamping BULK on the set path would make the
// flag's two paths write DIFFERENT history -- and byte-equality between them is the whole reason this is
// safe to deploy. Matching the web's BULK reason means threading a reason through the single close as
// well, which widens the diff into money-path code that is already live. Left for a separate change.
const CLOSE_BULK_RATE_LIMIT_PER_MINUTE = CLOSE_RATE_LIMIT_PER_MINUTE;

type BulkResult = {
  positionId: string;
  closed: boolean;
  closePrice: string | null;
  realizedPnl: string | null;
  error: string | null;
};

router.post(
  "/close-bulk",
  requireTraderSession,
  rateLimitOrders(CLOSE_BULK_RATE_LIMIT_PER_MINUTE, 60, "close"),
  validateBody(closeBulkSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as CloseBulkBody;
    const session = req.session!;
    const brokerId = req.headers["x-broker-id"] as string;

    // Same "finish" hook, and for the same reason, as the single close's: one line per answered
    // request, whichever of this handler's exits answered it. `n=` is here because a bulk close's
    // latency is meaningless without the basket size -- 400 ms for 2 positions and 400 ms for 40 are
    // not the same measurement.
    const t0 = Date.now();
    let tMark = t0;
    let basket = 0;
    const stage: string[] = [];
    const mark = (name: string) => {
      const now = Date.now();
      stage.push(`${name}=${now - tMark}ms`);
      tMark = now;
    };
    res.on("finish", () => {
      console.log(
        `[order-timing] route=close-bulk status=${res.statusCode} scope=${body.scope} n=${basket} total=${Date.now() - t0}ms ${stage.join(" ")}`
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

    // the scope the engine's close routes do not enforce
    const ingress = engineIngressVerdict(session.accountId, account.accountMode, undefined, account.engineLiveAllowlistOn, account.engineLiveEnabled);
    if (!ingress.ok) {
      res.status(403).json({ error: ingress.why });
      return;
    }

    // (1) this account's own open positions, oldest first -- the order the basket settles in
    const open: BulkTarget[] = await getOpenPositionsForBulk(session.accountId, brokerId);
    mark("select");
    if (open.length === 0) {
      res.status(200).json({ requested: 0, successful: 0, failed: 0, results: [] });
      return;
    }

    // (2) one fresh tick per distinct symbol, plus this account's ask rules. Fetched for EVERY open
    // symbol rather than only the in-scope ones, because under PROFIT / LOSS the scope cannot be decided
    // until the price is known -- the classification and the fill come from the same snapshot, which is
    // the property the whole selection rests on.
    const symbols = [...new Set(open.map((p) => p.symbolName))];
    const [prices, rules] = await Promise.all([
      getFreshPrices(symbols),
      loadAskRules(query, [session.accountId], brokerId),
    ]);
    mark("price");
    const accountRules = rules.get(session.accountId);
    // the account's marked close price: a BUY at its bid, a SELL at its ask (client-ask.ts, the same
    // port of lib/ask-markup.ts the single close uses). A symbol with no rule gets a zero markup, which
    // is the raw price -- never a silent skip.
    const markedClose = (p: BulkTarget, live: Live) => {
      const rule =
        accountRules?.get(p.symbolName) ?? { mode: "markup" as const, markupPips: new Decimal(0), digits: p.digits };
      return p.side === "BUY" ? clientBid(rule, live.bid, live.ask) : clientAsk(rule, live.bid, live.ask);
    };

    // (3) the scope, the side filter, the id narrowing and the per-position refusals -- all of it in
    // bulk-select.ts, which is pure and proved on a table there rather than asserted here.
    const selection = selectBulkBasket(open, body, prices, markedClose);
    const results = new Map<string, BulkResult>();
    for (const r of selection.refusals) {
      results.set(r.positionId, { positionId: r.positionId, closed: false, closePrice: null, realizedPnl: null, error: r.error });
    }
    const items = selection.closable.map(({ position, live }) => ({
      position_id: position.id,
      bid: live.bid.toString(),
      ask: live.ask.toString(),
    }));
    const order = selection.order;
    basket = order.length;
    if (order.length === 0) {
      res.status(200).json({ requested: 0, successful: 0, failed: 0, results: [] });
      return;
    }

    // (4) ONE call to the engine for everything that is closable
    if (items.length > 0) {
      const upstream = await fetch(`${TRADING_CORE_URL}/v1/positions/close-bulk`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
        body: JSON.stringify({
          account_id: session.accountId,
          items,
          idempotency_prefix: body.idempotencyKey ?? null,
        }),
      });
      const data = await parseUpstreamJson(upstream);
      mark("engine");
      if (!upstream.ok) {
        // A REFUSED BASKET IS NOT PARTIALLY APPLIED. The engine settles the set inside ONE transaction,
        // so a 500, or a 409 from a replayed idempotency key, means NOTHING was written. Hence a single
        // status here rather than per-position errors, which would imply some of the closes landed.
        console.error("[close-bulk] engine refused the basket", { status: upstream.status, n: items.length });
        if (upstream.status === 409) {
          res.status(409).json(data);
        } else {
          res.status(502).json({ error: "EXECUTION_UNAVAILABLE" });
        }
        return;
      }
      const rows = ((data as { results?: unknown }).results ?? []) as {
        position_id: string;
        status: string;
        close_price?: string;
        realized_pnl?: string;
      }[];
      for (const row of rows) {
        const closed = row.status === "CLOSED";
        results.set(row.position_id, {
          positionId: row.position_id,
          closed,
          closePrice: closed ? String(row.close_price ?? "") : null,
          realizedPnl: closed ? String(row.realized_pnl ?? "") : null,
          error: closed ? null : bulkErrorFor(row.status),
        });
      }
    }

    // (5) answer in selection order, which is settle order -- so the ledger the client reads back and
    // the list it renders run the same way. A position with no row at all would be a bug in the engine's
    // answer, so it is reported as one rather than quietly dropped.
    const out = order.map(
      (id) =>
        results.get(id) ?? { positionId: id, closed: false, closePrice: null, realizedPnl: null, error: "no answer" }
    );
    const successful = out.filter((r) => r.closed).length;

    // ONE audit row for the basket, not N. The per-position record already exists and is richer than
    // anything this could add: the engine writes a "Deal", a TRADE_PNL "Transaction" and a
    // PostCloseEffect per close, in the same transaction as the money. What this row carries is the ASK
    // -- who requested which scope, and what came back -- which is the part no engine artifact holds.
    await writeAuditLog({
      brokerId,
      action: "GATEWAY_POSITIONS_CLOSED_BULK",
      entityType: "Account",
      entityId: session.accountId,
      newValue: {
        scope: body.scope,
        ...(body.symbol ? { symbol: body.symbol } : {}),
        ...(body.side ? { side: body.side } : {}),
        idempotencyKey: body.idempotencyKey ?? null,
        requested: out.length,
        successful,
        closed: out.filter((r) => r.closed).map((r) => r.positionId),
      },
    }).catch((err) => console.error("audit log write failed", err));

    res.status(200).json({ requested: out.length, successful, failed: out.length - successful, results: out });
  }
);

export default router;
