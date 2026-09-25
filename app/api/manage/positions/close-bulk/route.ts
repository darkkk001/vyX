import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { closeBulkForAccount, type BulkCloseScope } from "@/lib/bulk-close";

const SCOPES: BulkCloseScope[] = ["ALL", "PROFIT", "LOSS", "SYMBOL"];

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Backoffice "close all for account" -- shares lib/bulk-close.ts's core
// with the trader-facing app/api/trade/positions/close-bulk/route.ts
// (same one-transaction, one-price-snapshot-per-symbol behavior), scoped
// to whichever account a dealer picks rather than "my own account".
export async function POST(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // owner decision 2026-09-25 (audit Batch 4): CLIENT_TRADING -- BROKER_ADMIN, or a MANAGER granted it. No second admin
  // (dealing needs speed); every action writes its audit row.
  if (await forbidUnlessBrokerAdminOrPermission(session, "CLIENT_TRADING")) {
    return NextResponse.json({ error: "forbidden", permission: "CLIENT_TRADING", permissionLabel: PERMISSION_LABELS.CLIENT_TRADING }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const body = await request.json().catch(() => null);

  // Live exposure's "close shown positions" (audit 2026-09-24, money): the exact positions the screen lists under its
  // current symbol / group / book / search filter, across accounts -- the confirm's "N shown positions" is exactly
  // what closes. Broker-scoped: ids of another broker, or not open, are ignored.
  if (Array.isArray(body?.positionIds)) {
    const ids = (body.positionIds as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 1000);
    if (ids.length === 0) return NextResponse.json({ error: "positionIds is empty" }, { status: 400 });
    const rows = await prisma.position.findMany({ where: { id: { in: ids }, brokerId, status: "OPEN" }, select: { id: true, accountId: true } });
    const byAccount = new Map<string, string[]>();
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r.id]);
    const results = [];
    for (const [acc, accIds] of byAccount) results.push(...(await closeBulkForAccount(prisma, { accountId: acc, brokerId, scope: "ALL", positionIds: accIds })));
    await prisma.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "MANUAL_POSITION_BULK_CLOSE",
        entityType: "Broker",
        entityId: brokerId,
        newValue: {
          scope: "SHOWN_POSITIONS",
          accounts: byAccount.size,
          requested: ids.length,
          open: rows.length,
          successful: results.filter((r) => r.closed).length,
          failed: results.filter((r) => !r.closed).length,
        },
      },
    });
    return NextResponse.json({
      requested: ids.length,
      successful: results.filter((r) => r.closed).length,
      failed: results.filter((r) => !r.closed).length,
      results,
    });
  }

  const accountId = typeof body?.accountId === "string" ? body.accountId : "";
  if (!accountId) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  const scope = SCOPES.includes(body?.scope) ? (body.scope as BulkCloseScope) : null;
  if (!scope) {
    return NextResponse.json({ error: "scope must be one of ALL, PROFIT, LOSS, SYMBOL" }, { status: 400 });
  }
  const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : undefined;
  if (scope === "SYMBOL" && !symbol) {
    return NextResponse.json({ error: "symbol is required for scope SYMBOL" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { brokerId: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const results = await closeBulkForAccount(prisma, { accountId, brokerId, scope, symbol });

  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: session.adminId,
      action: "MANUAL_POSITION_BULK_CLOSE",
      entityType: "Account",
      entityId: accountId,
      newValue: {
        scope,
        symbol: symbol ?? null,
        requested: results.length,
        successful: results.filter((r) => r.closed).length,
        failed: results.filter((r) => !r.closed).length,
      },
    },
  });

  return NextResponse.json({
    requested: results.length,
    successful: results.filter((r) => r.closed).length,
    failed: results.filter((r) => !r.closed).length,
    results,
  });
}
