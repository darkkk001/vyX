import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { hedgeBook } from "@/lib/hedge-book";

// GET /api/manage/coverage/book (Dealing redesign D10, owner 2026-10-26): the hedge book per symbol, the ONE answer behind
// the Dealing HEDGE MANAGER and the hedge account panel (lib/hedge-book.ts). DEALING: BROKER_ADMIN, or a MANAGER granted it.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await forbidUnlessBrokerAdminOrPermission(session!, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  return NextResponse.json(await hedgeBook(session!.brokerId!));
}
