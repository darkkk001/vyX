import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { hedgeBySymbol } from "@/lib/hedge-book";

// POST /api/manage/coverage/hedge-symbols (Dealing redesign D8, owner 2026-10-26): "Hedge n" for one symbol, "Hedge all"
// for every symbol. Body {symbols?: string[]} (absent or empty = all). One leg per symbol and side on the hedge account,
// same side as the clients, each client covered and linked to it (lib/hedge-book.ts). DEALING: BROKER_ADMIN, or a
// MANAGER granted it; one POSITION_COVERAGE_BOOKED audit row per client covered.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await forbidUnlessBrokerAdminOrPermission(session!, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const raw = Array.isArray(body?.symbols) ? (body.symbols as unknown[]) : [];
  const symbols = raw.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
  const results = await hedgeBySymbol(session!.brokerId!, session!.adminId, symbols.length > 0 ? symbols : undefined);
  return NextResponse.json({
    legsCreated: results.filter((r) => r.legTicket !== null).length,
    failed: results.filter((r) => r.error !== null).length,
    results,
  });
}
