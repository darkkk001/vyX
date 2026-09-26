import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: {
      id: true,
      accountNumber: true,
      accountMode: true,
      currency: true,
      leverage: true,
      balance: true,
      credit: true,
      status: true,
      fullName: true,
      twoFactorEnabled: true,
      // 2026-09-05 P0 fix -- WebTrader's own margin-call banner/toast used
      // to hardcode 100% rather than reading this account's real
      // configured level (Group.marginCallLevel). Null group = ungrouped
      // account, same 100 fallback Group.marginCallLevel's own schema
      // default already uses everywhere else (lib/margin.ts, lib/risk-monitor.ts).
      // `name` added alongside it for the native terminal's own account-
      // strip pill (v2 redesign's "Standard · 1:500" -- Group.name IS
      // "Standard" for a broker's default group, but this must read the
      // real value, never assume every broker names it that).
      group: { select: { marginCallLevel: true, stopOutLevel: true, name: true, tradingHaltedAt: true, closeOnlyAt: true, tradingRestriction: true } },
      broker: { select: { tradingHaltedAt: true, closeOnlyAt: true } },
    },
  });

  if (!account || account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const { group, broker, ...rest } = account;
  // Batch 5: whether this account can trade right now (the broker's or its group's halt / close-only; halted wins),
  // re-read by the terminal on every ConfigChanged so a halt shows at once
  const tradingState = broker?.tradingHaltedAt || group?.tradingHaltedAt ? "halted" : broker?.closeOnlyAt || group?.closeOnlyAt ? "close_only" : "open";
  // stopOutLevel (audit 2026-09-24): the terminal shows and warns at stop-out too, not only at margin call
  return NextResponse.json({ ...rest, marginCallLevel: (group?.marginCallLevel ?? 100).toString(), stopOutLevel: (group?.stopOutLevel ?? 50).toString(), groupName: group?.name ?? null, tradingState,
    // Phase 2 batch 3: the group's side restriction (BOTH / BUY_ONLY / SELL_ONLY), so the ticket disables the side the server refuses
    tradingRestriction: group?.tradingRestriction ?? "BOTH" });
}
