import { NextResponse } from "next/server";
import { roomApiSession } from "@/lib/room/context";
import { ensureWallet, findWallet, WalletUnavailable } from "@/lib/room/wallet";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

// GET: the wallet's balance from the ledger (zero until first use, nothing is created by a read).
// POST: the client starts using it; idempotent, answers the wallet's account id for the funds screens.
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { clientId, brokerId } = ctx.session;
  const [wallet, broker] = await Promise.all([findWallet(clientId, brokerId), prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true } })]);
  return NextResponse.json({ id: wallet?.id ?? null, accountNumber: wallet?.accountNumber ?? null, balance: wallet?.balance.toFixed(2) ?? "0.00", currency: wallet?.currency ?? broker.defaultAccountCurrency });
}

export async function POST() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { clientId, brokerId } = ctx.session;
  const { allowed } = await checkRateLimit(`room-wallet:${clientId}`, 10, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  try {
    const wallet = await ensureWallet(clientId, brokerId);
    return NextResponse.json({ id: wallet.id, accountNumber: wallet.accountNumber, balance: wallet.balance.toFixed(2), currency: wallet.currency });
  } catch (e) {
    if (e instanceof WalletUnavailable) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
