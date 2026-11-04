import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { equityAt, sessionOf } from "@/lib/room/analytics";
import { JOURNAL_SELECT, RULES, PRESET_TAGS, cleanTags, cleanChecklist, netOf, rOf } from "@/lib/room/journal";
import { checkRateLimit } from "@/lib/rate-limit";

// One closed trade of the client: GET -> the inspector (prices, stop, risk %, R, timing, the client's tags / note / rules
// check); PUT {tags, note, checklist} -> saves the client's part. Another client's trade answers like a missing one.
async function ownClosed(clientId: string, brokerId: string, id: string) {
  return prisma.position.findFirst({
    where: { id, status: "CLOSED", deletedAt: null, account: { clientId, brokerId } },
    select: { ...JOURNAL_SELECT, account: { select: { accountNumber: true } } },
  });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { id } = await params;
  const p = await ownClosed(ctx.session.clientId, ctx.session.brokerId, id);
  if (!p) return NextResponse.json({ error: "Trade not found." }, { status: 404 });
  const entry = await prisma.tradeJournalEntry.findUnique({ where: { positionId: p.id } });
  const digits = p.symbol.digits ?? 5;
  const net = netOf(p);
  const r = rOf(p);
  let riskPct: string | null = null;
  if (p.slPrice && p.closePrice && !p.closePrice.eq(p.openPrice)) {
    const riskMoney = (p.openPrice.sub(p.slPrice).abs().toNumber() / p.closePrice.sub(p.openPrice).abs().toNumber()) * Math.abs(net);
    const eq = await equityAt(p.accountId, p.openedAt);
    if (eq && eq > 0) riskPct = ((riskMoney / eq) * 100).toFixed(1);
  }
  const closedAt = p.closedAt ?? p.openedAt;
  return NextResponse.json({
    trade: {
      id: p.id, ticket: String(p.ticket), account: p.account.accountNumber, symbol: p.symbol.name, side: p.side, lots: (p.initialVolume ?? p.volume).toFixed(2),
      net: net.toFixed(2), entry: p.openPrice.toFixed(digits), exit: p.closePrice?.toFixed(digits) ?? "", sl: p.slPrice?.toFixed(digits) ?? null, riskPct,
      r: r == null ? null : r.toFixed(1), openedAt: p.openedAt.toISOString(), closedAt: closedAt.toISOString(), heldMinutes: Math.round((closedAt.getTime() - p.openedAt.getTime()) / 60000),
      session: sessionOf(p.openedAt),
    },
    entry: { tags: entry?.tags ?? [], note: entry?.note ?? "", checklist: cleanChecklist(entry?.checklist), savedAt: entry?.updatedAt.toISOString() ?? null },
    rules: RULES,
    presetTags: PRESET_TAGS,
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-journal:${session.clientId}`, 60, 60);
  if (!allowed) return NextResponse.json({ error: "Too many saves. Try again in a minute." }, { status: 429 });
  const { id } = await params;
  const p = await ownClosed(session.clientId, session.brokerId, id);
  if (!p) return NextResponse.json({ error: "Trade not found." }, { status: 404 });
  const body = await request.json().catch(() => null);
  const tags = cleanTags(body?.tags);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 4000) : "";
  const checklist = cleanChecklist(body?.checklist);
  const saved = await prisma.tradeJournalEntry.upsert({
    where: { positionId: p.id },
    create: { positionId: p.id, clientId: session.clientId, tags, note: note || null, checklist },
    update: { tags, note: note || null, checklist },
  });
  return NextResponse.json({ savedAt: saved.updatedAt.toISOString() });
}
