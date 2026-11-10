import type { RoomAccount } from "./RoomData";
import { money } from "./format";

// One item of the From / To lists: a trading account, or the funding wallet (key "wallet", also before it exists).
export type TransferItem = { key: string; id: string | null; isWallet: boolean; accountNumber: string; mode: RoomAccount["mode"]; currency: string; balance: string };
export const WALLET_KEY = "wallet";

// The From / To lists (owner 2026-11-10): every account, and the funding wallet for every client with live money (a live
// account or the wallet itself), shown before the wallet exists as "Funding wallet · 0.00 USD"; the first transfer into it
// creates it (app/api/room/transfer). To never lists the From item; within live or within demo; same currency, except that
// the wallet is always offered (the server answers a currency mismatch with its reason).
export function transferItems(accounts: RoomAccount[], wallet: RoomAccount | null, walletCurrency: string): TransferItem[] {
  const items: TransferItem[] = accounts.map((a) => ({ key: a.id, id: a.id, isWallet: false, accountNumber: a.accountNumber, mode: a.mode, currency: a.currency, balance: a.figures.balance }));
  if (wallet || accounts.some((a) => a.mode === "LIVE")) {
    items.push({ key: WALLET_KEY, id: wallet?.id ?? null, isWallet: true, accountNumber: wallet?.accountNumber ?? "", mode: "LIVE", currency: wallet?.currency ?? walletCurrency, balance: wallet?.figures.balance ?? "0.00" });
  }
  return items;
}
export function transferTargets(items: TransferItem[], from: TransferItem | null): TransferItem[] {
  if (!from) return [];
  return items.filter((i) => i.key !== from.key && i.mode === from.mode && (i.isWallet || from.isWallet || i.currency === from.currency));
}
export const itemLabel = (i: TransferItem) => `${i.isWallet ? "Funding wallet" : i.accountNumber} · ${money(i.balance)} ${i.currency}`;
