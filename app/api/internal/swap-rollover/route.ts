import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";
import { runSwapRollover } from "@/lib/swap-rollover";

// Triggered by Vercel Cron (see vercel.json) once a day -- Vercel sends a
// plain GET with `Authorization: Bearer $CRON_SECRET` automatically once
// that env var is set (https://vercel.com/docs/cron-jobs/manage-cron-jobs
// #securing-cron-jobs), no manual header wiring needed on the cron config
// side. Same bearer-secret shape as app/api/internal/price-feed's own
// check, just a different env var since this has nothing to do with the
// MT5 EA bridge's own secret.
//
// This route matches middleware.ts's `/api/internal/*` exclusion, so it
// never goes through broker-subdomain resolution -- correct here, since
// one run processes every broker's due positions in a single pass, not
// just one broker's.
export async function GET(request: NextRequest) {
  // constant-time compare (security re-audit 2026-10-23; was a plain !==)
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const summary = await runSwapRollover(prisma);
  return NextResponse.json(summary);
}
