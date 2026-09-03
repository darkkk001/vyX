import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, excludeSuperAdminActor } from "@/lib/audit-labels";

// entityId -- added for the omni-search's "order/position/transaction ID
// -> that record in context" destination (see app/api/manage/search's
// own comment): the search result links here with ?highlight=<id>, and
// this is what ClientActivityView.tsx scrolls to/highlights. Optional
// since an admin-action row has no single record it maps to as cleanly.
type TimelineRow = { time: string; kind: string; tone: "success" | "danger" | "warning" | "neutral" | "info" | "accent"; summary: string; entityId?: string };

// Same query app/manage/(shell)/accounts/[id]/page.tsx's Server Component
// used to do inline (account header fields + a merged AuditLog/
// Transaction/Order/Position timeline) -- exposed as JSON so a new
// ClientActivityView.tsx can self-fetch it instead of relying on a
// dynamic-route Server Component, which a bundled manager-shell desktop
// app (no real routing) has no equivalent of.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({
    where: { id },
    include: { group: { select: { name: true } }, kycRecord: { select: { status: true } } },
  });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const [auditLogs, transactions, orders, positions] = await Promise.all([
    prisma.auditLog.findMany({ where: { entityId: id, brokerId, ...excludeSuperAdminActor }, orderBy: { createdAt: "desc" }, take: 50, include: { actorAdmin: { select: { email: true } } } }),
    prisma.transaction.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.order.findMany({ where: { accountId: id }, orderBy: { createdAt: "desc" }, take: 50, include: { symbol: { select: { name: true } } } }),
    prisma.position.findMany({ where: { accountId: id }, orderBy: { openedAt: "desc" }, take: 50, include: { symbol: { select: { name: true } } } }),
  ]);

  const timeline: TimelineRow[] = [
    ...auditLogs.map((a): TimelineRow => ({
      time: a.createdAt.toISOString(),
      kind: "Admin action",
      tone: "accent",
      summary: `${humanizeAction(a.action)} — by ${a.actorAdmin?.email ?? "system"}`,
      entityId: a.id,
    })),
    ...transactions.map((t): TimelineRow => ({
      time: t.createdAt.toISOString(),
      kind: "Ledger",
      tone: t.amount.isNegative() ? "danger" : "success",
      summary: `${t.type} — ${t.amount.toString()} (${t.status})${t.note ? ` — ${t.note}` : ""}`,
      entityId: t.id,
    })),
    ...orders.map((o): TimelineRow => ({
      time: o.createdAt.toISOString(),
      kind: "Order",
      tone: o.status === "REJECTED" || o.status === "CANCELLED" ? "danger" : "info",
      summary: `${o.side} ${o.volume} ${o.symbol.name} ${o.type} — ${o.status}${o.rejectionReason ? ` (${o.rejectionReason})` : ""}`,
      entityId: o.id,
    })),
    ...positions.map((p): TimelineRow => ({
      time: p.openedAt.toISOString(),
      kind: "Position",
      tone: p.status === "OPEN" ? "warning" : "neutral",
      summary: `${p.side} ${p.volume} ${p.symbol.name} opened @ ${p.openPrice.toString()}${p.status === "CLOSED" ? ` — closed @ ${p.closePrice?.toString() ?? "—"}, P&L ${p.realizedPnl?.toString() ?? "—"}` : " — OPEN"}`,
      entityId: p.id,
    })),
  ].sort((a, b) => (a.time < b.time ? 1 : -1));

  return NextResponse.json({
    account: {
      fullName: account.fullName,
      accountNumber: account.accountNumber,
      email: account.email,
      accountType: account.accountType,
      status: account.status,
      groupName: account.group?.name ?? null,
      kycStatus: account.kycRecord?.status ?? null,
    },
    timeline: timeline.slice(0, 150).map((row) => ({ ...row, timeLabel: row.time.replace("T", " ").slice(0, 19) })),
  });
}
