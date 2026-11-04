import { withConfigEvent } from "@/lib/config-events";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import {
  checkCserverHasSymbols,
  checkSymbolRow,
  connectionSnapshot,
  LpConnectionInputError,
  parseConnectionFields,
  symbolSnapshot,
  touchesTimeouts,
} from "@/lib/lp-connection-input";
import { CONNECTION_INCLUDE, connectionView, loadConnection } from "@/lib/lp-connections";

// One LP connection (A.1.3). PATCH changes session fields or switches it on / off; DELETE removes it with its symbol
// rows. BROKER_ADMIN; every change is audited with the old and new values. A request that changes nothing writes
// nothing.

async function brokerAdmin() {
  const session = await getAdminSession();
  return requireAdminRole(session, ["BROKER_ADMIN"]) && session!.brokerId ? session! : null;
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const c = await loadConnection(prisma, (await params).id, session.brokerId!);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(connectionView(c, { timeouts: false }));
}

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (touchesTimeouts(body)) return NextResponse.json({ error: "timeouts and retries are set by the platform operator" }, { status: 403 });
  if (body && "liquidityProviderId" in body) {
    return NextResponse.json({ error: "a connection cannot move to another provider: delete it and add a new one" }, { status: 400 });
  }
  try {
    const fields = await parseConnectionFields(prisma, brokerId, body, false);
    const result = await prisma.$transaction(async (tx) => {
      const before = await loadConnection(tx, id, brokerId, true);
      if (!before) return null;
      const merged = { ...before, ...fields };
      if (merged.tls === "OFF" && merged.tlsServerName) throw new LpConnectionInputError("a TLS server name needs TLS on");
      // a switch to cTrader: every existing venue symbol must already be its numeric id
      for (const s of before.symbols) checkSymbolRow(s, merged.dialect);
      checkCserverHasSymbols(merged.dialect, merged.enabled, before.symbols.length);
      const changed = Object.entries(fields).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v);
      if (changed.length === 0) return { row: before };
      const row = await tx.lpConnection.update({ where: { id }, data: Object.fromEntries(changed), include: CONNECTION_INCLUDE });
      const onlyEnabled = changed.length === 1 && changed[0][0] === "enabled";
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: onlyEnabled ? (row.enabled ? "LP_CONNECTION_ENABLED" : "LP_CONNECTION_DISABLED") : "LP_CONNECTION_CHANGED",
          entityType: "LpConnection",
          entityId: id,
          oldValue: connectionSnapshot(before),
          newValue: connectionSnapshot(row),
        },
      });
      return { row };
    });
    if (!result) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(connectionView(result.row, { timeouts: false }));
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

async function deleteHandler(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;
  const { id } = await params;
  const deleted = await prisma.$transaction(async (tx) => {
    const before = await loadConnection(tx, id, brokerId, true);
    if (!before) return false;
    await tx.lpConnection.delete({ where: { id } }); // its symbol rows go with it (ON DELETE CASCADE)
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "LP_CONNECTION_DELETED",
        entityType: "LpConnection",
        entityId: id,
        oldValue: { ...connectionSnapshot(before), liquidityProvider: before.liquidityProvider.name, symbols: before.symbols.map((s) => symbolSnapshot(s, s.symbol.name)) },
        newValue: { deleted: true },
      },
    });
    return true;
  });
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id, deleted: true });
}

// live reference data (owner 2026-10-29): every open backoffice re-reads this list at once
export const PATCH = withConfigEvent("lps", patchHandler);
export const DELETE = withConfigEvent("lps", deleteHandler);
