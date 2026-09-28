import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveEntityLabels } from "@/lib/entity-labels";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, auditEntityHref, excludeSuperAdminActor, summarizeAuditDiff, extractOrderIdentity } from "@/lib/audit-labels";

// Same query app/manage/(shell)/audit/page.tsx's Server Component used
// to do inline -- exposed as JSON so AuditLogTable.tsx can fetch it
// itself (both the website and a bundled desktop shell use this one
// path now, instead of the website baking it into server-rendered props
// a bundled shell has no Server Component to produce).
//
// Broker feedback items 14+15 -- ?q= searches order number and account
// number, both embedded in oldValue/newValue by lib/order-audit.ts's
// orderAuditFields (there's no dedicated column for either on AuditLog),
// plus a plain entityId match so a non-order row like an Account or
// AdminUser id still finds its own log rows the way it always could.
const AUDIT_PAGE = 200;

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = new URL(request.url).searchParams;
  const q = sp.get("q")?.trim();

  // Phase 2 batch 7 (issue 79): a date range and paging. from / to (ISO date or datetime; a bare `to` date includes
  // that whole day, like the deals route) and the keyset `before` + `beforeId` (the `createdAt` and `id` of the last
  // row already shown: the next page is everything older, ties on the same millisecond broken by id). The body stays
  // the bare array; x-truncated says whether an older page exists.
  const createdAt: Prisma.DateTimeFilter = {};
  const fromRaw = sp.get("from")?.trim();
  if (fromRaw) {
    const d = new Date(fromRaw);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  const toRaw = sp.get("to")?.trim();
  if (toRaw) {
    const d = new Date(toRaw);
    if (!Number.isNaN(d.getTime())) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) d.setUTCDate(d.getUTCDate() + 1);
      createdAt.lt = d;
    }
  }
  const beforeRaw = sp.get("before")?.trim();
  const beforeId = sp.get("beforeId")?.trim() || null;
  const before = beforeRaw ? new Date(beforeRaw) : null;
  const keyset: Prisma.AuditLogWhereInput | null =
    before && !Number.isNaN(before.getTime())
      ? { OR: [{ createdAt: { lt: before } }, ...(beforeId ? [{ createdAt: before, id: { lt: beforeId } }] : [])] }
      : null;

  const logs = await prisma.auditLog.findMany({
    where: {
      brokerId: session!.brokerId!,
      ...excludeSuperAdminActor,
      ...(createdAt.gte || createdAt.lt ? { createdAt } : {}),
      ...(keyset ? { AND: [keyset] } : {}),
      ...(q
        ? {
            OR: [
              { entityId: { contains: q, mode: "insensitive" } },
              // Phase 2 batch 6 (issue 76): the screen promises actor, action and entity-type search too
              { actorAdmin: { email: { contains: q, mode: "insensitive" } } },
              { action: { contains: q.replace(/\s+/g, "_"), mode: "insensitive" } },
              { entityType: { contains: q, mode: "insensitive" } },
              { oldValue: { path: ["orderNumber"], string_contains: q } },
              { newValue: { path: ["orderNumber"], string_contains: q } },
              { oldValue: { path: ["accountNumber"], string_contains: q } },
              { newValue: { path: ["accountNumber"], string_contains: q } },
            ] satisfies Prisma.AuditLogWhereInput["OR"],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: AUDIT_PAGE + 1,
    include: { actorAdmin: { select: { email: true } } },
  });
  const truncated = logs.length > AUDIT_PAGE;
  if (truncated) logs.length = AUDIT_PAGE;

  const entityLabels = await resolveEntityLabels(session!.brokerId!, logs.map((l) => ({ entityType: l.entityType, entityId: l.entityId })));
  return NextResponse.json(
    logs.map((log) => ({
      id: log.id,
      actorEmail: log.actorAdmin?.email ?? "system",
      actionLabel: humanizeAction(log.action),
      // Phase 2 batch 6 (issue 78): the raw action, so a client can route a row (RISK_* / DEALING_* -> their screens)
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      entityLabel: entityLabels.get(log.entityId ?? "") ?? "",
      href: auditEntityHref(log.entityType, log.entityId),
      order: extractOrderIdentity(log.oldValue, log.newValue),
      diffLines: summarizeAuditDiff(log.oldValue, log.newValue),
      createdAtLabel: log.createdAt.toISOString().replace("T", " ").slice(0, 19),
      // the keyset cursor for the next page (full precision, with `id` as beforeId)
      createdAt: log.createdAt.toISOString(),
    })),
    { headers: { "x-row-limit": String(AUDIT_PAGE), "x-truncated": truncated ? "true" : "false" } }
  );
}
