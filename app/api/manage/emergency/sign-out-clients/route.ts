import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { revokeAllAccountSessions } from "@/lib/account-auth";
import { revokeAllClientSessions } from "@/lib/client-auth";
import { brokerHosts } from "@/lib/broker-hosts";

// Step 2 (owner 2026-09-30): EMG "Sign out all clients". Ends every session of every trading account (WebTrader +
// desktop terminal) and every client-portal session of THIS broker. Staff sessions are not touched.
// BROKER_ADMIN only. Typed confirm, checked here on the server: body { confirm } must equal one of the broker's own
// web addresses (its subdomain host, e.g. futurixglobal.vyxtrader.com, or its custom domain, with or without www),
// case-insensitive. Audited (BROKER_CLIENT_SESSIONS_REVOKED) with the counts, before any revoke runs.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { subdomain: true, customDomain: true } });
  if (!broker) return NextResponse.json({ error: "broker not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
  const hosts = brokerHosts(broker);
  if (!confirm || !hosts.includes(confirm)) {
    return NextResponse.json({ error: `type ${hosts[0]} to confirm`, expected: hosts[0] }, { status: 400 });
  }

  const [accounts, clients] = await Promise.all([
    prisma.account.findMany({ where: { brokerId }, select: { id: true } }),
    prisma.client.findMany({ where: { brokerId }, select: { id: true } }),
  ]);
  const audit = await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: session!.adminId,
      action: "BROKER_CLIENT_SESSIONS_REVOKED",
      entityType: "Broker",
      entityId: brokerId,
      newValue: { confirm, accounts: accounts.length, portalClients: clients.length },
    },
  });

  let accountSessions = 0;
  for (const a of accounts) accountSessions += await revokeAllAccountSessions(a.id);
  let portalSessions = 0;
  for (const c of clients) portalSessions += await revokeAllClientSessions(c.id);

  return NextResponse.json({ auditId: audit.id, accounts: accounts.length, accountSessionsRevoked: accountSessions, portalClients: clients.length, portalSessionsRevoked: portalSessions });
}
