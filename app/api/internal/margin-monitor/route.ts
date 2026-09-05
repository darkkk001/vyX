import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk } from "@/lib/risk-monitor";

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
  const expectedSecret = process.env.CRON_SECRET ?? "";
  const auth = request.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!expectedSecret || provided !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Cheapest possible check first, index-backed: if nothing is open
  // anywhere on the platform, there is nothing to protect this minute --
  // bail out immediately rather than even fetching the distinct account
  // list.
  const openCount = await prisma.position.count({ where: { status: "OPEN" } });
  if (openCount === 0) {
    return NextResponse.json({ accountsEvaluated: 0, errors: 0 });
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

  return NextResponse.json({ accountsEvaluated: openAccounts.length, errors });
}
