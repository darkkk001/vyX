import { withConfigEvent } from "@/lib/config-events";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
// owner 2026-11-10: Liquidity providers is a delegatable permission (BROKER_ADMIN, or a MANAGER holding LIQUIDITY_PROVIDERS)
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { checkSymbolRow, LpConnectionInputError, parseSymbolFields, symbolSnapshot } from "@/lib/lp-connection-input";
import { connectionView, loadConnection } from "@/lib/lp-connections";

// One symbol row of an LP connection. PATCH: venue symbol / contract size / minimum / step (the platform symbol itself
// does not change: remove the row and add another). DELETE: refused (409) when it is the last symbol of an enabled
// cTrader connection, which the bridge would refuse to run. BROKER_ADMIN; both audited.

async function brokerAdmin() {
  const session = await getAdminSession();
  return (await forbidUnlessBrokerAdminOrPermission(session, "LIQUIDITY_PROVIDERS")) ? null : session!;
}

async function patchHandler(request: NextRequest, { params }: { params: Promise<{ id: string; rowId: string }> }) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;
  const { id, rowId } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && "symbolId" in body) return NextResponse.json({ error: "the platform symbol of a row does not change: remove it and add another" }, { status: 400 });
  try {
    const fields = await parseSymbolFields(prisma, brokerId, body, false);
    const row = await prisma.$transaction(async (tx) => {
      const c = await loadConnection(tx, id, brokerId, true);
      const before = c?.symbols.find((s) => s.id === rowId);
      if (!c || !before) return null;
      const merged = { ...before, ...fields };
      checkSymbolRow(merged, c.dialect);
      const changed = Object.entries(fields).filter(([k, v]) => String((before as Record<string, unknown>)[k]) !== String(v));
      if (changed.length === 0) return c;
      await tx.lpConnectionSymbol.update({ where: { id: rowId }, data: Object.fromEntries(changed) });
      await tx.auditLog.create({
        data: {
          brokerId,
          actorAdminId: session.adminId,
          action: "LP_CONNECTION_SYMBOL_CHANGED",
          entityType: "LpConnection",
          entityId: id,
          oldValue: symbolSnapshot(before, before.symbol.name),
          newValue: symbolSnapshot(merged, before.symbol.name),
        },
      });
      return loadConnection(tx, id, brokerId);
    });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(connectionView(row, { timeouts: false }));
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

async function deleteHandler(_request: NextRequest, { params }: { params: Promise<{ id: string; rowId: string }> }) {
  const session = await brokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId!;
  const { id, rowId } = await params;
  try {
    const row = await prisma.$transaction(async (tx) => {
      const c = await loadConnection(tx, id, brokerId, true);
      const before = c?.symbols.find((s) => s.id === rowId);
      if (!c || !before) return null;
      if (c.dialect === "CSERVER" && c.enabled && c.symbols.length === 1) {
        throw new LpConnectionInputError("the last symbol of an enabled cTrader connection: disable the connection first", 409);
      }
      await tx.lpConnectionSymbol.delete({ where: { id: rowId } });
      await tx.auditLog.create({
        data: { brokerId, actorAdminId: session.adminId, action: "LP_CONNECTION_SYMBOL_REMOVED", entityType: "LpConnection", entityId: id, oldValue: symbolSnapshot(before, before.symbol.name), newValue: { deleted: true } },
      });
      return loadConnection(tx, id, brokerId);
    });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(connectionView(row, { timeouts: false }));
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

// live reference data (owner 2026-10-29): every open backoffice re-reads this list at once
export const PATCH = withConfigEvent("lps", patchHandler);
export const DELETE = withConfigEvent("lps", deleteHandler);
