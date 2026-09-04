import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { mergeChartIndicators, type ChartIndicatorsState } from "@/lib/chart-indicators";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { chartIndicators: true },
  });
  return NextResponse.json({ indicators: mergeChartIndicators(account?.chartIndicators) });
}

// Whole-object replace, same pattern as chart-settings' own PUT -- the
// only caller (WebTrader.tsx's indicator add/edit/remove handlers)
// always has the full current list in hand before saving.
export async function PUT(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "an indicators object is required" }, { status: 400 });
  }

  const merged: ChartIndicatorsState = mergeChartIndicators(body);
  await prisma.account.update({
    where: { id: session.accountId },
    data: { chartIndicators: merged },
  });
  return NextResponse.json({ indicators: merged });
}
