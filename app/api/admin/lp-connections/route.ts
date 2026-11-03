import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { CONNECTION_INCLUDE, connectionView } from "@/lib/lp-connections";

// Super Admin: a broker's LP connections WITH their timeout / retry values (owner decision 2026-11-03: those are the
// platform operator's, never a broker's). GET ?broker=<subdomain>. Change them with PATCH /api/admin/lp-connections/[id].
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const slug = (request.nextUrl.searchParams.get("broker") ?? "").trim().toLowerCase();
  const broker = slug ? await prisma.broker.findUnique({ where: { subdomain: slug }, select: { id: true } }) : null;
  if (!broker) return NextResponse.json({ error: "unknown broker" }, { status: 404 });
  const rows = await prisma.lpConnection.findMany({ where: { brokerId: broker.id }, include: CONNECTION_INCLUDE, orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map((c) => connectionView(c, { timeouts: true })));
}
