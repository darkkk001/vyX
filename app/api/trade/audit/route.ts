import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { describeOrderAuditEvent } from "@/lib/order-audit";

// Broker feedback items 14+15 -- the trader's own "Logs" tab
// (components/webtrader/WebTrader.tsx) previously only showed ephemeral,
// session-local messages that reset on every reload. This surfaces the
// same persisted AuditLog rows the backoffice audit page reads
// (app/api/manage/audit/route.ts), scoped to this account's own orders,
// as human-readable lines -- see lib/order-audit.ts's
// describeOrderAuditEvent. AuditLog has no accountId column; every
// order-lifecycle row carries the account's number in its own JSON
// payload instead (lib/order-audit.ts's orderAuditFields), so that's what
// this filters on.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const account = await prisma.account.findUnique({ where: { id: session.accountId }, select: { accountNumber: true } });
  if (!account) {
    return NextResponse.json([]);
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      brokerId: session.brokerId,
      OR: [
        { oldValue: { path: ["accountNumber"], equals: account.accountNumber } },
        { newValue: { path: ["accountNumber"], equals: account.accountNumber } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(
    logs
      .map((log) => ({
        id: log.id,
        time: log.createdAt.toISOString().slice(11, 19),
        message: describeOrderAuditEvent(log.action, log.oldValue, log.newValue),
      }))
      .filter((l): l is { id: string; time: string; message: string } => l.message !== null)
  );
}
