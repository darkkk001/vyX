import { Prisma } from "@prisma/client";

// The top-bar money menu (owner 2026-11-10): the client's real money, never demo. Overall = the funding wallet + every
// LIVE trading account's balance, in USD. Each line keeps its own balance and currency; the USD figure is the server's
// conversion (lib/fx.ts conversionRate), null when no price converts it, and then Overall says it is partial. The partner
// wallet (an IB's unpaid commission) is listed under it but is not money on an account yet, so Overall leaves it out.
// Pure: the route (app/api/room/money) loads the rows and the rate.

export type MoneyAccount = { id: string; accountNumber: string; balance: Prisma.Decimal; currency: string };
export type MoneyInput = {
  accounts: (MoneyAccount & { mode: "LIVE" | "DEMO"; isWallet: boolean })[];
  partner: { accountNumber: string; unpaid: Prisma.Decimal; currency: string } | null;
  walletCurrency: string;
};
type Rate = (from: string, to: string) => Prisma.Decimal | null;

export type MoneyLine = { id: string | null; accountNumber: string | null; balance: string; currency: string; usd: string | null };
export type RoomMoney = {
  currency: "USD";
  overall: string;
  partial: boolean;
  accounts: MoneyLine[];
  wallet: MoneyLine;
  partner: MoneyLine | null;
};

export function summarizeMoney(input: MoneyInput, rate: Rate): RoomMoney {
  const line = (a: { id: string | null; accountNumber: string | null; balance: Prisma.Decimal; currency: string }): MoneyLine => {
    const r = rate(a.currency, "USD");
    return { id: a.id, accountNumber: a.accountNumber, balance: a.balance.toFixed(2), currency: a.currency, usd: r ? a.balance.mul(r).toFixed(2) : null };
  };
  const live = input.accounts.filter((a) => a.mode === "LIVE" && !a.isWallet);
  const w = input.accounts.find((a) => a.isWallet) ?? null;
  const accounts = live.map(line);
  const wallet = w ? line(w) : line({ id: null, accountNumber: null, balance: new Prisma.Decimal(0), currency: input.walletCurrency });
  const counted = [...accounts, wallet];
  const overall = counted.reduce((s, l) => (l.usd != null ? s.add(l.usd) : s), new Prisma.Decimal(0));
  return {
    currency: "USD",
    overall: overall.toFixed(2),
    partial: counted.some((l) => l.usd == null),
    accounts,
    wallet,
    partner: input.partner ? line({ id: null, accountNumber: input.partner.accountNumber, balance: input.partner.unpaid, currency: input.partner.currency }) : null,
  };
}
