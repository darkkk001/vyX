import { NextResponse } from "next/server";
import { brokerServers, serverForKind } from "@/lib/broker-servers";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { accountFigures } from "@/lib/room/figures";
import { roomTransactions } from "@/lib/room/transactions";
import { platformBrand } from "@/lib/room/platform-brand";
import { shownAvatar } from "@/lib/room/bitmoji";
import { shownAvatarOf } from "@/lib/avatars";

// Trader's Room Dashboard: the client, every own account with the server's figures, totals over the LIVE accounts
// (only when they share one currency), the five latest money rows and the verification state.
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;

  const [client, accounts] = await Promise.all([
    prisma.client.findUnique({
      where: { id: session.clientId },
      select: { fullName: true, email: true, clientNumber: true, prevLoginAt: true, passwordHash: true, bitmojiAvatarUrl: true, avatarPreset: true, kycRecord: { select: { status: true, documentFrontUrl: true, addressProofUrl: true, rejectionReason: true } } },
    }),
    prisma.account.findMany({
      where: { clientId: session.clientId, brokerId: session.brokerId, status: { not: "CLOSED" }, archivedAt: null },
      select: { isWallet: true, nickname: true, investorPasswordHash: true, id: true, accountNumber: true, accountMode: true, currency: true, leverage: true, balance: true, credit: true, brokerId: true, createdAt: true, passwordHash: true, group: { select: { displayName: true } } },
      orderBy: [{ accountMode: "desc" }, { createdAt: "asc" }], // LIVE first
    }),
  ]);
  if (!client) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });

  const servers = brokerServers(session.broker.name);
  const all = await Promise.all(accounts.map(async (a) => ({
    isWallet: a.isWallet,
    nickname: a.nickname,
    server: serverForKind(servers, a.accountMode)?.name ?? "",
    readOnlyPassword: a.investorPasswordHash !== null,
    id: a.id,
    accountNumber: a.accountNumber,
    mode: a.accountMode,
    plan: a.isWallet ? "Funding wallet" : a.group?.displayName ?? "Standard",
    leverage: a.leverage,
    currency: a.currency,
    openedAt: a.createdAt.toISOString(),
    // the portal password signs in to this account too (same hash; never the hash itself)
    portalPassword: a.passwordHash === client?.passwordHash,
    figures: await accountFigures(a),
  })));

  const withFigures = all.filter((a) => !a.isWallet);
  const wallet = all.find((a) => a.isWallet) ?? null;
  const live = withFigures.filter((a) => a.mode === "LIVE");
  const currencies = new Set(live.map((a) => a.currency));
  const sum = (k: "balance" | "equity" | "freeMargin" | "floating") => live.reduce((s, a) => s + Number(a.figures[k]), 0).toFixed(2);
  // the dashboard strip (owner 2026-11-09): live trading accounts only, summed; demo never counts; no live account = 0.00
  const totals = live.length === 0
    ? { currency: "USD", balance: "0.00", equity: "0.00", freeMargin: "0.00", floating: "0.00" }
    : currencies.size === 1
      ? { currency: [...currencies][0], balance: sum("balance"), equity: sum("equity"), freeMargin: sum("freeMargin"), floating: sum("floating") }
      : null;
  // the top bar's money: the funding wallet (real money), 0.00 until it exists
  const realFunds = { amount: wallet ? wallet.figures.balance : "0.00", currency: wallet?.currency ?? "USD" };
  // the wallet's currency also before it exists (it is created in the broker's default account currency, lib/room/wallet.ts)
  const walletCurrency = wallet?.currency ?? (await prisma.broker.findUnique({ where: { id: session.brokerId }, select: { defaultAccountCurrency: true } }))?.defaultAccountCurrency ?? "USD";

  const ownNumbers = new Set(accounts.map((a) => a.accountNumber));
  // Recent transactions, live and demo apart (owner 2026-11-09: the dashboard shows live by default, a toggle shows demo);
  // the funding wallet is a live ledger account, so it counts as live
  const recentOf = async (mode: "LIVE" | "DEMO") => {
    const ids = accounts.filter((a) => a.accountMode === mode).map((a) => a.id);
    return ids.length ? (await roomTransactions({ accountIds: ids, types: ["Deposit", "Withdrawal", "Transfer"] }, ownNumbers, { skip: 0, take: 5 })).rows : [];
  };
  const [recentLive, recentDemo] = await Promise.all([recentOf("LIVE"), recentOf("DEMO")]);

  const kyc = client.kycRecord;
  return NextResponse.json({
    client: { fullName: client.fullName, email: client.email, clientId: `C-${client.clientNumber}`, lastLoginAt: client.prevLoginAt?.toISOString() ?? null, avatarUrl: shownAvatarOf(shownAvatar(session.broker.subdomain, client.bitmojiAvatarUrl), client.avatarPreset).url },
    kyc: kyc
      ? { status: kyc.status, identity: Boolean(kyc.documentFrontUrl), address: Boolean(kyc.addressProofUrl), rejectionReason: kyc.rejectionReason ?? null }
      : { status: "NONE", identity: false, address: false, rejectionReason: null },
    accounts: withFigures,
    wallet,
    walletCurrency,
    // the platform the account cards and Settings name: the broker's own brand (lib/room/platform-brand.ts)
    platform: platformBrand(session.broker.name),
    totals,
    realFunds,
    recent: recentLive,
    recentDemo,
  });
}
