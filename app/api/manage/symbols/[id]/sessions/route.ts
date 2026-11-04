import { NextRequest, NextResponse } from "next/server";
import { withConfigEvent } from "@/lib/config-events";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { validateSessions } from "@/lib/symbol-sessions";
import { readSessions, sessionWindow } from "@/lib/symbol-write";
import { writeRefusal } from "@/lib/group-permissions";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// `id` here is BrokerSymbol.id (not Symbol.id) -- this is per-broker
// config, same scoping as every other field on that model. Enforcement
// reads TradingSession via BrokerSymbol.tradingSessions -- see
// lib/risk.ts's checkTradingSession (TRADE rows only; QUOTE rows are the quote-streaming windows).
//
// Rules for the rows (lib/symbol-sessions.ts validateSessions): kind TRADE (default) or QUOTE, openTime HH:MM, closeTime
// HH:MM or 24:00, no overlap per day and kind, a window crossing midnight stored as two rows. All times UTC.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const brokerSymbol = await prisma.brokerSymbol.findUnique({ where: { id } });
  if (!brokerSymbol || brokerSymbol.brokerId !== session.brokerId) {
    return NextResponse.json({ error: "symbol not found" }, { status: 404 });
  }

  const sessions = await prisma.tradingSession.findMany({
    where: { brokerSymbolId: id },
    orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }],
  });

  return NextResponse.json(sessions.map((s) => ({ id: s.id, kind: s.kind, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })));
}

// Replaces the full session list for this symbol -- simplest correct
// semantics for a small, admin-edited list (no per-row add/delete
// endpoints needed). Empty array = no configured rows (the default week applies, see checkTradingSession).
async function putHandler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  { const refused = await writeRefusal(session, ["config"], "manage/symbols/[id]/sessions PUT"); if (refused) return refused; } // GROUPS_SYMBOLS

  const brokerSymbol = await prisma.brokerSymbol.findUnique({ where: { id }, include: { symbol: { select: { name: true } } } });
  if (!brokerSymbol || brokerSymbol.brokerId !== session.brokerId) {
    return NextResponse.json({ error: "symbol not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.sessions)) {
    return NextResponse.json({ error: "sessions must be an array", rowErrors: [] }, { status: 400 });
  }
  const { rows, rowErrors } = validateSessions(body.sessions);
  if (rowErrors.length > 0) {
    return NextResponse.json({ error: "some sessions are invalid", rowErrors }, { status: 400 });
  }

  // Phase 2 batch 6 (issue 172): the replace and its audit row (old and new windows) commit together
  await prisma.$transaction(async (tx) => {
    const before = await readSessions(tx, id);
    await tx.tradingSession.deleteMany({ where: { brokerSymbolId: id } });
    if (rows.length > 0) await tx.tradingSession.createMany({ data: rows.map((s) => ({ ...s, brokerSymbolId: id })) });
    await tx.auditLog.create({
      data: {
        brokerId: session.brokerId!,
        actorAdminId: session.adminId,
        action: "SYMBOL_SESSIONS_UPDATED",
        entityType: "BrokerSymbol",
        entityId: id,
        oldValue: { symbol: brokerSymbol.symbol.name, sessions: before.map(sessionWindow) },
        newValue: { symbol: brokerSymbol.symbol.name, sessions: rows.map(sessionWindow) },
      },
    });
  });

  const updated = await prisma.tradingSession.findMany({ where: { brokerSymbolId: id }, orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }] });
  return NextResponse.json(updated.map((s) => ({ id: s.id, kind: s.kind, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })));
}

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const PUT = withConfigEvent("sessions", putHandler);
