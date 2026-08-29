import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, auditEntityHref, excludeSuperAdminActor, summarizeAuditDiff } from "@/lib/audit-labels";

// Same query app/manage/(shell)/audit/page.tsx's Server Component used
// to do inline -- exposed as JSON so AuditLogTable.tsx can fetch it
// itself (both the website and a bundled desktop shell use this one
// path now, instead of the website baking it into server-rendered props
// a bundled shell has no Server Component to produce).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const logs = await prisma.auditLog.findMany({
    where: { brokerId: session!.brokerId!, ...excludeSuperAdminActor },
    orderBy: { createdAt: "desc" },
    take: 100,
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
      diffLines: summarizeAuditDiff(log.oldValue, log.newValue),
      createdAtLabel: log.createdAt.toISOString().replace("T", " ").slice(0, 19),
    }))
  );
}
