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
// Vercel Cron's minimum schedule granularity is 1 minute -- there is no
// sub-minute cron syntax, so "every 30 seconds" is approximated within
// that floor: one invocation runs a full evaluation pass, waits ~25s,
// then runs a second pass before returning, giving two real evaluations
// per minute instead of one. This needs `maxDuration` above the ~25-30s
// the sleep alone costs, and Vercel's actual allowed function duration
// depends on the project's plan (Hobby's default is well under this;
// Pro/Enterprise support higher via `maxDuration`, up to their own caps) --
// disclosed rather than assumed. If this project is on a plan that can't
// sustain a ~30-50s function, the second pass will be cut short by
// Vercel's own timeout and only the first pass's protection lands that
// minute -- still strictly better than zero, but confirm the plan
// supports it for the full two-pass cadence.
export const maxDuration = 60;

const SLEEP_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runOnePass(): Promise<{ accountsEvaluated: number; errors: number }> {
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
  return { accountsEvaluated: openAccounts.length, errors };
}

export async function GET(request: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET ?? "";
  const auth = request.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!expectedSecret || provided !== expectedSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pass1 = await runOnePass();
  await sleep(SLEEP_MS);
  const pass2 = await runOnePass();

  return NextResponse.json({ pass1, pass2 });
}
