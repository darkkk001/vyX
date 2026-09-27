import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { CHART_SETTINGS_MAX_BYTES, DEFAULT_CHART_SETTINGS, mergeChartSettings, validateChartSettings, type ChartSettings } from "@/lib/chart-settings";

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
  // Phase 2 batch 6 (issue 254): capped, only known keys stored, each type-checked (lib/chart-settings.ts)
  const raw = await request.text().catch(() => "");
  if (raw.length > CHART_SETTINGS_MAX_BYTES) {
    return NextResponse.json({ error: `settings document too large (max ${CHART_SETTINGS_MAX_BYTES} bytes)` }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const checked = validateChartSettings(body);
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }

  const merged: ChartSettings = { ...DEFAULT_CHART_SETTINGS, ...checked.settings };
  await prisma.account.update({
    where: { id: session.accountId },
    data: { chartSettings: merged },
  });
  return NextResponse.json({ settings: merged });
}
