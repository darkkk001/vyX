import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { crmStaff, crmOwners, clientRef, handleOf } from "@/lib/crm/core";
import { crmTimeline } from "@/lib/crm/timeline";
import { maskPhone } from "@/lib/crm/leads";
import { auditLabel } from "@/lib/crm/activity";
import { excludeSuperAdminActor, deleteAuditFilter } from "@/lib/audit-labels";

// Client 360. GET -> contact, accounts with balances, lifetime deposits / withdrawals / net, notes, open tasks and the
// activity feed (system events from the audit trail + staff notes, newest first). PATCH {ownerId} -> assign.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("read");
  if ("response" in g) return g.response;
  const brokerId = g.staff.brokerId;
  const { id } = await params;
  const c = await prisma.client.findFirst({
    where: { id, brokerId },
    select: {
      id: true, clientNumber: true, fullName: true, email: true, phone: true, country: true, createdAt: true, lastLoginAt: true, ownerAdminId: true, source: true, status: true, referredByClientId: true,
      kycRecord: { select: { status: true } },
      accounts: { select: { id: true, accountNumber: true, accountMode: true, balance: true, currency: true, status: true, group: { select: { displayName: true } } }, orderBy: [{ accountMode: "desc" }, { createdAt: "asc" }] },
    },
  });
  if (!c) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  const liveIds = c.accounts.filter((a) => a.accountMode === "LIVE").map((a) => a.id);
  const accountIds = c.accounts.map((a) => a.id);
  const [dep, wd, audit, timeline, owner, referrer] = await Promise.all([
    liveIds.length ? prisma.transaction.aggregate({ where: { accountId: { in: liveIds }, type: "DEPOSIT", status: "COMPLETED" }, _sum: { amount: true } }) : null,
    liveIds.length ? prisma.transaction.aggregate({ where: { accountId: { in: liveIds }, type: "WITHDRAWAL", status: "COMPLETED" }, _sum: { amount: true } }) : null,
    prisma.auditLog.findMany({
      // same visibility as the broker's own audit views: no Super Admin rows, trade-delete records by role
      where: { brokerId, ...excludeSuperAdminActor, AND: [deleteAuditFilter(g.staff.role), { OR: [{ clientId: c.id }, ...(accountIds.length ? [{ entityType: "Account", entityId: { in: accountIds } }] : [])] }] },
      select: { id: true, action: true, createdAt: true, actorAdminId: true, newValue: true, entityId: true },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    crmTimeline(brokerId, "CLIENT", c.id),
    c.ownerAdminId ? prisma.adminUser.findUnique({ where: { id: c.ownerAdminId }, select: { email: true } }) : null,
    c.referredByClientId ? prisma.client.findFirst({ where: { id: c.referredByClientId, brokerId }, select: { referralCode: true, clientNumber: true } }) : null,
  ]);
  const admins = await prisma.adminUser.findMany({ where: { id: { in: [...new Set(audit.map((a) => a.actorAdminId).filter((x): x is string => !!x))] } }, select: { id: true, email: true } });
  const handle = new Map(admins.map((a) => [a.id, handleOf(a.email)]));
  const numberById = new Map(c.accounts.map((a) => [a.id, a.accountNumber]));
  const deposits = dep?._sum.amount ?? new Prisma.Decimal(0);
  const withdrawals = (wd?._sum.amount ?? new Prisma.Decimal(0)).abs();
  const activity = [
    ...audit.map((a) => {
      const src = String(((a.newValue ?? {}) as Record<string, unknown>).source ?? "");
      return { at: a.createdAt.toISOString(), by: a.actorAdminId ? handle.get(a.actorAdminId) ?? "STAFF" : src.startsWith("CLIENT") ? "CLIENT" : "SYSTEM", text: auditLabel(a.action, a.newValue, numberById.get(a.entityId) ?? null) };
    }),
    ...timeline.notes.map((n) => ({ at: n.at, by: n.by, text: n.body })),
  ].filter((x) => x.text).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 80);
  return NextResponse.json({
    client: {
      id: c.id, ref: clientRef(c.clientNumber), fullName: c.fullName, email: c.email, phone: maskPhone(c.phone), country: c.country,
      registeredAt: c.createdAt.toISOString(), lastLoginAt: c.lastLoginAt?.toISOString() ?? null, kyc: c.kycRecord?.status ?? "NONE",
      source: c.source ?? (referrer?.referralCode ? `IB · ${referrer.referralCode}` : "WEBSITE"),
      owner: c.ownerAdminId && owner ? { id: c.ownerAdminId, handle: handleOf(owner.email), email: owner.email } : null,
      // owner 2026-11-14: the client whose link this one signed up through (their user id), shown when no staff member owns the client
      referrer: c.referredByClientId && referrer ? { id: c.referredByClientId, ref: clientRef(referrer.clientNumber) } : null,
      suspended: c.status !== "ACTIVE",
    },
    accounts: c.accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, plan: a.group?.displayName ?? "Standard", mode: a.accountMode, balance: a.balance.toFixed(2), currency: a.currency, status: a.status })),
    lifetime: { deposits: deposits.toFixed(2), withdrawals: withdrawals.toFixed(2), net: deposits.sub(withdrawals).toFixed(2) },
    tasks: timeline.tasks,
    activity,
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await crmStaff("write");
  if ("response" in g) return g.response;
  const { staff } = g;
  const { id } = await params;
  const b = await request.json().catch(() => null);
  if (!b || !("ownerId" in b)) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  const ownerId = typeof b.ownerId === "string" && b.ownerId ? b.ownerId : null;
  const owners = await crmOwners(staff.brokerId);
  if (ownerId && !owners.some((o) => o.id === ownerId)) return NextResponse.json({ error: "Unknown owner." }, { status: 400 });
  const c = await prisma.client.findFirst({ where: { id, brokerId: staff.brokerId }, select: { id: true, ownerAdminId: true } });
  if (!c) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  await prisma.client.update({ where: { id: c.id }, data: { ownerAdminId: ownerId } });
  const who = ownerId ? handleOf(owners.find((o) => o.id === ownerId)!.email) : null;
  await prisma.crmNote.create({ data: { brokerId: staff.brokerId, entityType: "CLIENT", entityId: c.id, authorAdminId: staff.adminId, body: who ? `Assigned to ${who}.` : "Unassigned." } });
  await prisma.auditLog.create({ data: { brokerId: staff.brokerId, actorAdminId: staff.adminId, clientId: c.id, action: "CLIENT_OWNER_CHANGED", entityType: "Client", entityId: c.id, oldValue: { ownerId: c.ownerAdminId }, newValue: { ownerId } } });
  return NextResponse.json({ owner: ownerId ? { id: ownerId, handle: who } : null });
}
