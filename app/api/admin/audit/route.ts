import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, summarizeAuditDiff } from "@/lib/audit-labels";

// Same query app/(super-admin)/(shell)/audit/page.tsx's Server Component
// used to do inline -- exposed as JSON so a new AuditLogTable client
// component can fetch it itself (both the website and a bundled
// admin-shell desktop app use this one path now).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 150,
    include: { actorAdmin: { select: { email: true } }, broker: { select: { name: true } } },
  });

  return NextResponse.json(
    logs.map((log) => ({
      id: log.id,
      actorEmail: log.actorAdmin?.email ?? "system",
      actionLabel: humanizeAction(log.action),
      brokerName: log.broker?.name ?? null,
      diffLines: summarizeAuditDiff(log.oldValue, log.newValue),
      createdAtLabel: log.createdAt.toISOString().replace("T", " ").slice(0, 19),
    }))
  );
}
