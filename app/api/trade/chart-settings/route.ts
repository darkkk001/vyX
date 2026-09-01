import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { DEFAULT_CHART_SETTINGS, mergeChartSettings, type ChartSettings } from "@/lib/chart-settings";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: { chartSettings: true },
  });
  return NextResponse.json({ settings: mergeChartSettings(account?.chartSettings) });
}

// Whole-object replace, same pattern as watchlist reorder's "client sends
// the full desired state" shape -- simpler than a partial-patch merge, and
// the only caller (ChartSettingsDialog.tsx) always has the full object in
// hand (it started from a GET's merged result).
export async function PUT(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "a settings object is required" }, { status: 400 });
  }

  const merged: ChartSettings = { ...DEFAULT_CHART_SETTINGS, ...body };
  await prisma.account.update({
    where: { id: session.accountId },
    data: { chartSettings: merged },
  });
  return NextResponse.json({ settings: merged });
}
