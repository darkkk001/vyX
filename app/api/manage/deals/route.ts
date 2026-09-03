import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Same query app/manage/(shell)/deals/page.tsx's Server Component used
// to do inline -- exposed as JSON so DealsManager can fetch it itself
// (both the website and a bundled manager-shell desktop app use this
// one path now).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  // VYX-POSITION-TOOLS-V0 -- VOIDED rows belong here too (the brief's
  // "visible to admins" for Void has nowhere else to land: the Live
  // Exposure page only ever shows status: OPEN, so a just-voided position
  // used to vanish from every backoffice view the instant it voided).
  // deletedAt: null hides a soft-deleted row from this normal-browsing
  // list -- "recoverable from the audit view" (the brief's own words)
  // means the audit log, not this list; see POSITION_DELETED's own
  // AuditLog entry for the full record.
  const positions = await prisma.position.findMany({
    where: { brokerId, status: { in: ["CLOSED", "VOIDED"] }, deletedAt: null },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { closedAt: "desc" },
    take: 500,
  });

  return NextResponse.json(
    positions.map((p) => ({
      id: p.id,
      accountNumber: p.account.accountNumber,
      accountFullName: p.account.fullName,
      symbol: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      status: p.status,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      closePrice: p.closePrice ? p.closePrice.toFixed(p.symbol.digits) : "—",
      commission: p.commission.toFixed(2),
      swap: p.swap.toFixed(2),
      realizedPnl: p.realizedPnl ? p.realizedPnl.toFixed(2) : "—",
      closedAt: p.closedAt ? p.closedAt.toISOString().replace("T", " ").slice(0, 19) : "—",
    }))
  );
}
