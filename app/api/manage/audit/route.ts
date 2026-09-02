import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const q = new URL(request.url).searchParams.get("q")?.trim();

  const logs = await prisma.auditLog.findMany({
    where: {
      brokerId: session!.brokerId!,
      ...excludeSuperAdminActor,
      ...(q
        ? {
            OR: [
              { entityId: { contains: q, mode: "insensitive" } },
              { oldValue: { path: ["orderNumber"], string_contains: q } },
              { newValue: { path: ["orderNumber"], string_contains: q } },
              { oldValue: { path: ["accountNumber"], string_contains: q } },
              { newValue: { path: ["accountNumber"], string_contains: q } },
            ] satisfies Prisma.AuditLogWhereInput["OR"],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { actorAdmin: { select: { email: true } } },
  });

  return NextResponse.json(
    logs.map((log) => ({
      id: log.id,
      actorEmail: log.actorAdmin?.email ?? "system",
      actionLabel: humanizeAction(log.action),
      entityType: log.entityType,
      entityId: log.entityId,
      href: auditEntityHref(log.entityType, log.entityId),
      order: extractOrderIdentity(log.oldValue, log.newValue),
      diffLines: summarizeAuditDiff(log.oldValue, log.newValue),
      createdAtLabel: log.createdAt.toISOString().replace("T", " ").slice(0, 19),
    }))
  );
}
