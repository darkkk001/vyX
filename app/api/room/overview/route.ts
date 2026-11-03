import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { accountFigures } from "@/lib/room/figures";
import { roomTransactions } from "@/lib/room/transactions";

// Trader's Room Dashboard: the client, every own account with the server's figures, totals over the LIVE accounts
// (only when they share one currency), the five latest money rows and the verification state.
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;

  const [client, accounts] = await Promise.all([
    prisma.client.findUnique({
      where: { id: session.clientId },
      select: { fullName: true, email: true, clientNumber: true, prevLoginAt: true, passwordHash: true, kycRecord: { select: { status: true, documentFrontUrl: true, addressProofUrl: true, rejectionReason: true } } },
    }),
    prisma.account.findMany({
      where: { clientId: session.clientId, brokerId: session.brokerId, status: { not: "CLOSED" } },
      select: { id: true, accountNumber: true, accountMode: true, currency: true, leverage: true, balance: true, credit: true, brokerId: true, createdAt: true, passwordHash: true, group: { select: { displayName: true } } },
      orderBy: [{ accountMode: "desc" }, { createdAt: "asc" }], // LIVE first
    }),
  ]);
  if (!client) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });

  const withFigures = await Promise.all(accounts.map(async (a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    mode: a.accountMode,
    plan: a.group?.displayName ?? "Standard",
    leverage: a.leverage,
    currency: a.currency,
    openedAt: a.createdAt.toISOString(),
    // the portal password signs in to this account too (same hash; never the hash itself)
    portalPassword: a.passwordHash === client?.passwordHash,
    figures: await accountFigures(a),
  })));

  const live = withFigures.filter((a) => a.mode === "LIVE");
  const currencies = new Set(live.map((a) => a.currency));
  const sum = (k: "balance" | "equity" | "freeMargin" | "floating") => live.reduce((s, a) => s + Number(a.figures[k]), 0).toFixed(2);
  const totals = live.length > 0 && currencies.size === 1
    ? { currency: [...currencies][0], balance: sum("balance"), equity: sum("equity"), freeMargin: sum("freeMargin"), floating: sum("floating") }
    : null;

  const ownNumbers = new Set(accounts.map((a) => a.accountNumber));
  const recent = accounts.length
    ? await roomTransactions({ accountIds: accounts.map((a) => a.id), types: ["Deposit", "Withdrawal", "Transfer"] }, ownNumbers, { skip: 0, take: 5 })
    : { rows: [], total: 0 };

  const kyc = client.kycRecord;
  return NextResponse.json({
    client: { fullName: client.fullName, email: client.email, clientId: `C-${client.clientNumber}`, lastLoginAt: client.prevLoginAt?.toISOString() ?? null },
    kyc: kyc
      ? { status: kyc.status, identity: Boolean(kyc.documentFrontUrl), address: Boolean(kyc.addressProofUrl), rejectionReason: kyc.rejectionReason ?? null }
      : { status: "NONE", identity: false, address: false, rejectionReason: null },
    accounts: withFigures,
    totals,
    recent: recent.rows,
  });
}
