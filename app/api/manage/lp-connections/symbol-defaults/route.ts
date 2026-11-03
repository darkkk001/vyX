import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { LpConnectionInputError, symbolDefaults } from "@/lib/lp-connection-input";

// GET ?symbolId=: the pre-fill for a new symbol row on an LP connection: the platform's contract size, and the
// broker's minimum lot and lot step in units (the backoffice shows these; the broker changes them when the LP's
// grid differs). BROKER_ADMIN.
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const symbolId = request.nextUrl.searchParams.get("symbolId") ?? "";
  try {
    return NextResponse.json(await symbolDefaults(prisma, session!.brokerId!, symbolId));
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
