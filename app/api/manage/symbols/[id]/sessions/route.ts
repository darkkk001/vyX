import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// `id` here is BrokerSymbol.id (not Symbol.id) -- this is per-broker
// config, same scoping as every other field on that model. Enforcement
// reads TradingSession via BrokerSymbol.tradingSessions -- see
// lib/risk.ts's checkTradingSession.
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

  return NextResponse.json(sessions.map((s) => ({ id: s.id, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })));
}

// Replaces the full session list for this symbol -- simplest correct
// semantics for a small, admin-edited list (no per-row add/delete
// endpoints needed). Empty array = always tradable (see checkTradingSession).
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const brokerSymbol = await prisma.brokerSymbol.findUnique({ where: { id } });
  if (!brokerSymbol || brokerSymbol.brokerId !== session.brokerId) {
    return NextResponse.json({ error: "symbol not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  const raw = Array.isArray(body?.sessions) ? body.sessions : null;
  if (!raw) {
    return NextResponse.json({ error: "sessions must be an array" }, { status: 400 });
  }

  const sessions: { dayOfWeek: number; openTime: string; closeTime: string }[] = [];
  for (const s of raw) {
    const dayOfWeek = Number(s?.dayOfWeek);
    const openTime = typeof s?.openTime === "string" ? s.openTime : "";
    const closeTime = typeof s?.closeTime === "string" ? s.closeTime : "";
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return NextResponse.json({ error: "dayOfWeek must be 0-6" }, { status: 400 });
    }
    if (!TIME_RE.test(openTime) || !TIME_RE.test(closeTime)) {
      return NextResponse.json({ error: "openTime/closeTime must be HH:MM" }, { status: 400 });
    }
    if (openTime >= closeTime) {
      return NextResponse.json({ error: "closeTime must be after openTime" }, { status: 400 });
    }
    sessions.push({ dayOfWeek, openTime, closeTime });
  }

  await prisma.$transaction([
    prisma.tradingSession.deleteMany({ where: { brokerSymbolId: id } }),
    ...(sessions.length > 0 ? [prisma.tradingSession.createMany({ data: sessions.map((s) => ({ ...s, brokerSymbolId: id })) })] : []),
  ]);

  const updated = await prisma.tradingSession.findMany({ where: { brokerSymbolId: id }, orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }] });
  return NextResponse.json(updated.map((s) => ({ id: s.id, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })));
}
