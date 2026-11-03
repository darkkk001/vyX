import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { checkSymbolRow, LpConnectionInputError, parseSymbolFields, symbolSnapshot } from "@/lib/lp-connection-input";
import { connectionView, loadConnection } from "@/lib/lp-connections";

// POST: map one more platform symbol on an LP connection (the bridge's [[lp.symbol]]): venue symbol, contract size,
// minimum and step in units. BROKER_ADMIN; audited LP_CONNECTION_SYMBOL_ADDED. Answers the whole connection.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session!.brokerId!;
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const fields = (await parseSymbolFields(prisma, brokerId, body, true)) as Required<Awaited<ReturnType<typeof parseSymbolFields>>>;
    const row = await prisma.$transaction(async (tx) => {
      const c = await loadConnection(tx, id, brokerId, true);
      if (!c) return null;
      checkSymbolRow(fields, c.dialect);
      const s = await tx.lpConnectionSymbol.create({ data: { lpConnectionId: id, ...fields }, include: { symbol: { select: { name: true } } } });
      await tx.auditLog.create({
        data: { brokerId, actorAdminId: session!.adminId, action: "LP_CONNECTION_SYMBOL_ADDED", entityType: "LpConnection", entityId: id, newValue: symbolSnapshot(s, s.symbol.name) },
      });
      return loadConnection(tx, id, brokerId);
    });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(connectionView(row, { timeouts: false }), { status: 201 });
  } catch (e) {
    if (e instanceof LpConnectionInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "this symbol is already mapped on this connection" }, { status: 409 });
    }
    throw e;
  }
}
