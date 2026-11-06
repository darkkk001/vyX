import "server-only";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/client-auth";
import { provisionAccount } from "@/lib/account-provisioning";
import { roomPlans } from "@/lib/room/plans";

// The client's funding wallet (owner 2026-11-06). Funds stay with the broker as today: the wallet is one more LIVE ledger
// account, so a deposit, a withdrawal or a transfer through it runs the same code, locks, approvals and audit as any
// account (lib/transfer.ts, lib/funds-request-create.ts). What makes it a wallet:
//  - Account.isWallet, at most one per client (partial unique index);
//  - READ_ONLY trading rights, no sign-in (lib/account-auth.ts refuses it), so it can never hold a position;
//  - it is left out of every list of trading accounts.
// It is created on the client's first use, never on a read.
export class WalletUnavailable extends Error {}

export function findWallet(clientId: string, brokerId: string) {
  return prisma.account.findFirst({ where: { clientId, brokerId, isWallet: true }, select: { id: true, accountNumber: true, currency: true, balance: true, status: true } });
}

export async function ensureWallet(clientId: string, brokerId: string) {
  const existing = await findWallet(clientId, brokerId);
  if (existing) return existing;
  const [client, broker, plans] = await Promise.all([
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { fullName: true, email: true, country: true, phone: true, dateOfBirth: true } }),
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true, defaultAccountLeverage: true } }),
    roomPlans(brokerId, "LIVE"),
  ]);
  if (!plans[0]) throw new WalletUnavailable("The wallet is not available right now.");
  try {
    await provisionAccount({
      brokerId, fullName: client.fullName, email: client.email,
      passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")), // nobody knows it, and sign-in is refused anyway
      accountMode: "LIVE", accountTypeId: null, currency: broker.defaultAccountCurrency, leverage: broker.defaultAccountLeverage, groupId: plans[0].groupId,
      initialBalance: new Prisma.Decimal(0), country: client.country, phone: client.phone, dateOfBirth: client.dateOfBirth,
      clientId, createdByAdminId: null, isWallet: true, nickname: "Funding wallet",
    });
  } catch (e) {
    // two first uses at once: the unique index let one through, and that one is the wallet
    const won = await findWallet(clientId, brokerId);
    if (won) return won;
    throw e;
  }
  return (await findWallet(clientId, brokerId))!;
}
