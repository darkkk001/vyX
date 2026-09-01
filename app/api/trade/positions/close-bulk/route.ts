import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { closeBulkForAccount, type BulkCloseScope } from "@/lib/bulk-close";

const SCOPES: BulkCloseScope[] = ["ALL", "PROFIT", "LOSS", "SYMBOL"];

// Replaces the trader terminal's old "Close all / Close profitable /
// Close losing / Close all in <symbol>" buttons, each of which used to
// fire one /positions/[id]/close call per position sequentially
// (components/webtrader/WebTrader.tsx's closeManyBy/closeManyBySymbol) --
// 30 positions took 15-20s, each closing at a slightly different price as
// the feed ticked between calls. This is one request, one transaction,
// one price snapshot per symbol -- see lib/bulk-close.ts for the shared
// logic this shares with the backoffice's own "close all for account".
export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const scope = SCOPES.includes(body?.scope) ? (body.scope as BulkCloseScope) : null;
  if (!scope) {
    return NextResponse.json({ error: "scope must be one of ALL, PROFIT, LOSS, SYMBOL" }, { status: 400 });
  }
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : undefined;
  if (scope === "SYMBOL" && !symbol) {
    return NextResponse.json({ error: "symbol is required for scope SYMBOL" }, { status: 400 });
  }

  const results = await closeBulkForAccount(prisma, {
    accountId: session.accountId,
    brokerId: session.brokerId,
    scope,
    symbol,
  });

  return NextResponse.json({
    requested: results.length,
    successful: results.filter((r) => r.closed).length,
    failed: results.filter((r) => !r.closed).length,
    results,
  });
}
