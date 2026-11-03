import "server-only";
import { prisma } from "@/lib/prisma";
import { loadAccountMarginState } from "@/lib/margin";

// Trader's Room account figures: the server's own margin math (lib/margin.ts loadAccountMarginState, the same live
// side-aware prices, markup, fx and hedged margin the order routes check against). The room only formats them.

export type RoomAccountFigures = {
  balance: string;
  credit: string;
  equity: string;
  freeMargin: string;
  floating: string;
  usedMargin: string;
  marginLevel: string | null; // null = no used margin
  openPositions: number;
  priced: boolean; // false = a price or fx rate is missing right now: equity shown as balance + credit
};

const fixed = (d: { toFixed(n: number): string }) => d.toFixed(2);

export async function accountFigures(a: { id: string; leverage: number; brokerId: string; balance: { toFixed(n: number): string }; credit: { toFixed(n: number): string } }): Promise<RoomAccountFigures> {
  const state = await loadAccountMarginState(prisma, a.id, a.leverage, [], a.brokerId).catch(() => null);
  if (!state) {
    const bal = Number(a.balance.toFixed(2));
    const cr = Number(a.credit.toFixed(2));
    return { balance: fixed(a.balance), credit: fixed(a.credit), equity: (bal + cr).toFixed(2), freeMargin: (bal + cr).toFixed(2), floating: "0.00", usedMargin: "0.00", marginLevel: null, openPositions: 0, priced: false };
  }
  const { account, equity, usedMargin } = state;
  const floating = equity.sub(account.balance).sub(account.credit);
  return {
    balance: fixed(account.balance),
    credit: fixed(account.credit),
    equity: fixed(equity),
    freeMargin: fixed(equity.sub(usedMargin)),
    floating: fixed(floating),
    usedMargin: fixed(usedMargin),
    marginLevel: usedMargin.gt(0) ? equity.div(usedMargin).mul(100).toFixed(2) : null,
    openPositions: state.openPositions,
    priced: true,
  };
}
