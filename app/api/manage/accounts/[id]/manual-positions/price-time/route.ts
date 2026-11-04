import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { lookupPriceTime } from "@/lib/price-time";

// Manual position: open time from the open price (staff order brief point 8, owner 2026-10-29), BROKER_ADMIN, same broker.
//   GET ?symbolId=&side=&price= -> { at, precision, timeframe, series } | { at: null, reason: "NOT_FOUND" } (never an error for "not found")
// The most recent moment the symbol traded at that price, never in the future and never before the account opened (lib/price-time.ts).
// Typing triggers it (the app debounces); rate-limited per staff member.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return NextResponse.json({ error: "Only a broker admin can add a manual position." }, { status: 403 });
  const { id } = await params;
  const { allowed } = await checkRateLimit(`manual-price-time:${session!.adminId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: "Too many lookups. Wait a moment." }, { status: 429 });
  const q = request.nextUrl.searchParams;
  const price = Number((q.get("price") ?? "").replace(/,/g, ""));
  const symbolId = q.get("symbolId") ?? "";
  if (!symbolId || !Number.isFinite(price) || price <= 0) return NextResponse.json({ error: "symbolId and a positive price are required" }, { status: 400 });
  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true, createdAt: true } });
  if (!account || account.brokerId !== session!.brokerId) return NextResponse.json({ error: "account not found" }, { status: 404 });
  const bs = await prisma.brokerSymbol.findFirst({ where: { brokerId: session!.brokerId!, symbolId }, select: { symbol: { select: { name: true } } } });
  if (!bs) return NextResponse.json({ error: "symbol not available for this broker" }, { status: 400 });
  return NextResponse.json(await lookupPriceTime(bs.symbol.name, price, account.createdAt));
}
