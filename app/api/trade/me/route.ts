import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { tradingDayStart, tradingWeekStart } from "@/lib/trading-day";
import { clientAccountInfo } from "@/lib/client-execution";

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
      tradingRights: true,
      fullName: true,
      twoFactorEnabled: true,
      // 2026-09-05 P0 fix -- WebTrader's own margin-call banner/toast used
      // to hardcode 100% rather than reading this account's real
      // configured level (Group.marginCallLevel). Null group = ungrouped
      // account, same 100 fallback Group.marginCallLevel's own schema
      // default already uses everywhere else (lib/margin.ts, lib/risk-monitor.ts).
      // displayName = the client-facing account plan (owner 2026-10-23). Group.name is internal ("Dealing", "Reverse"...)
      // and is never selected here: the account strip shows accountPlan.
      group: { select: { marginCallLevel: true, stopOutLevel: true, displayName: true, tradingHaltedAt: true, closeOnlyAt: true, tradingRestriction: true } },
      broker: { select: { tradingHaltedAt: true, closeOnlyAt: true } },
    },
  });

  if (!account || account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account not found" }, { status: 404 });
  }

  const { group, broker, ...rest } = account;
  // Batch 5: whether this account can trade right now (the broker's or its group's halt / close-only; halted wins),
  // re-read by the terminal on every ConfigChanged so a halt shows at once
  // Per-account trading rights (2026-09-28): READ_ONLY reads as "halted" and CLOSE_ONLY as "close_only", so an installed
  // terminal (which knows open / close_only / halted) already disables what the server refuses; tradingRights below
  // is the exact value for the wording
  const tradingState = broker?.tradingHaltedAt || group?.tradingHaltedAt || rest.tradingRights === "READ_ONLY" ? "halted"
    : broker?.closeOnlyAt || group?.closeOnlyAt || rest.tradingRights === "CLOSE_ONLY" ? "close_only" : "open";
  // stopOutLevel (audit 2026-09-24): the terminal shows and warns at stop-out too, not only at margin call
  // Phase 2 batch 9 (issue 363, owner decision): the broker's trading day / week start (the charts' D1 boundary), so the
  // terminal's DAY P/L and WEEK P/L are counted from the same instants the server and the charts use
  const day = await tradingDayStart();
  return NextResponse.json(clientAccountInfo({ ...rest, tradingDayStart: day.start.toISOString(), tradingWeekStart: tradingWeekStart(day.start).toISOString(), tradingDaySource: day.source, marginCallLevel: (group?.marginCallLevel ?? 100).toString(), stopOutLevel: (group?.stopOutLevel ?? 50).toString(), accountPlan: group?.displayName ?? "Standard", tradingState,
    // Phase 2 batch 3: the group's side restriction (BOTH / BUY_ONLY / SELL_ONLY), so the ticket disables the side the server refuses
    tradingRestriction: group?.tradingRestriction ?? "BOTH" }));
}
