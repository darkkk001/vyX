import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk, evaluateRiskForSymbol } from "@/lib/risk-monitor";
import { bearerMatches } from "@/lib/internal-auth";
import { drainPostCloseBackstop } from "@/lib/post-close";
import { evaluatePendingTriggers } from "@/lib/pending-trigger";
import { anyFreshPriceOnVps } from "@/lib/live-price";

// 2026-09-05 P0 fix -- the reliable floor beneath the tick-ingest trigger
// (lib/price-feed.ts's ingestTicks -> evaluateRiskForSymbol), which is
// provably dead-or-uncertain in production: docs/market-data.md's own
// "confirmed dead/404" note plus the MT5 EA's direct-mode config mean a
// single-trigger design already went a full week with zero stop-out/
// margin-call coverage on live accounts, silently. This cron runs the
// exact same evaluateAccountRisk (lib/risk-monitor.ts -- SL/TP, stop-out,
// and the standing margin-call warning, all in one pass) against every
// account holding at least one open position, using fresh prices,
// regardless of whether a single tick ever reaches this app's own ingest
// path. Keep the tick-path trigger too (it's strictly additive, evaluating
// an at-risk account sooner than the next cron tick when it does work) --
// this is the floor under it, not a replacement.
//
// 2026-09-05 cost fix -- this originally ran two evaluation passes per
// invocation with a ~25s sleep between them, to approximate the requested
// "every 30 seconds" within Vercel Cron's real 1-minute floor. That burned
// ~25-30s of function-seconds on EVERY single invocation regardless of
// whether there was anything to protect that minute -- most minutes for
// most brokers have few or zero open positions. Replaced with a single
// fast pass: a stop-out landing within ~60s (worst case, an account going
// bad the instant after this minute's pass already ran) is well within
// what real brokers' own risk engines target, and the cost difference is
// the whole point of this rewrite -- idle minutes should cost close to
// nothing, not a mandatory 25s sleep. The Position.status index
// (migration 20260905200000_position_status_index) keeps the cheap-bailout
// count below actually cheap regardless of how large the historical
// (CLOSED) position table grows.
export const maxDuration = 15;

export async function GET(request: NextRequest) {
  // constant-time compare (2026-09-24; was a plain !==)
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Engine risk hook (engine/market-data/src/risk_hook.rs): the tick that touches an open
  // SL / TP fires this route for THAT symbol only -- evaluate its accounts now, not on the
  // next minute. Same evaluation the cron runs, scoped.
  const symbolsParam = request.nextUrl.searchParams.get("symbols");
  if (symbolsParam) {
    const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
    let errors = 0;
    for (const symbol of symbols) {
      try {
        await evaluateRiskForSymbol(symbol);
      } catch (err) {
        errors++;
        console.error("margin-monitor: symbol evaluation failed", symbol, err);
      }
    }
    // resting LIMIT / STOP orders on these symbols whose entry the price reached (Batch 4: server-side trigger)
    const pending = await evaluatePendingTriggers(symbols).catch((err) => {
      console.error("margin-monitor: pending trigger failed", err);
      return null;
    });
    return NextResponse.json({ symbolsEvaluated: symbols.length, errors, pending });
  }

  // Idle gate (Neon load, 2026-09-26): with no fresh tick on ANY symbol (weekend, feed down) nothing below can
  // decide anything -- every SL/TP, stop-out and pending trigger needs a price at most 15 s old -- so the full pass
  // returns before touching the database (the engine's backstop applies the same rule, market_data::activity; this
  // covers the Vercel cron). Asked of the engine's tick cache, not the DB. Unknown (not on the VPS price source, or
  // the engine unreachable) = run the pass as before. The post-close outbox only fills from engine closes, which need
  // a fresh price too; anything left in it runs on the first pass after the feed ticks again.
  if ((await anyFreshPriceOnVps()) === false) {
    return NextResponse.json({ skipped: "no fresh price on any symbol", accountsEvaluated: 0, errors: 0 });
  }

  // Cheapest possible check first, index-backed: if nothing is open
  // anywhere on the platform, there is nothing to protect this minute --
  // bail out immediately rather than even fetching the distinct account
  // list.
  // Rust cutover Stage 3 backstop: post-close outbox rows the engine's dispatcher has not finished within 2
  // minutes (engine down, or the route unreachable from the VPS) run here. One indexed query when there are none.
  const outbox = await drainPostCloseBackstop().catch((err) => {
    console.error("margin-monitor: post-close backstop failed", err);
    return { ran: 0, failed: 0 };
  });

  // every resting LIMIT / STOP order (Batch 4: server-side trigger; the engine's 60 s pass and this cron are the floor
  // under the tick hook) -- before the no-open-positions bail-out, since a pending order needs no open position
  const pending = await evaluatePendingTriggers().catch((err) => {
    console.error("margin-monitor: pending trigger sweep failed", err);
    return null;
  });

  const openCount = await prisma.position.count({ where: { status: "OPEN" } });
  if (openCount === 0) {
    return NextResponse.json({ accountsEvaluated: 0, errors: 0, outbox, pending });
  }

  const openAccounts = await prisma.position.findMany({
    where: { status: "OPEN" },
    select: { accountId: true },
    distinct: ["accountId"],
  });

  let errors = 0;
  for (const { accountId } of openAccounts) {
    try {
      await evaluateAccountRisk(accountId);
    } catch (err) {
      errors++;
      console.error("margin-monitor: evaluation failed for account", accountId, err);
    }
  }

  return NextResponse.json({ accountsEvaluated: openAccounts.length, errors, outbox, pending });
}
