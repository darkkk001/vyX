import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getClientSession, hashPassword } from "@/lib/client-auth";
import { generateTemporaryPassword } from "@/lib/passwords";
import { provisionAccount } from "@/lib/account-provisioning";
import { consumeRevealedCredentials } from "@/lib/live-account-credentials";
import { checkRateLimit } from "@/lib/rate-limit";

// Client Portal's own Trading Accounts tab (Stage 6). GET lists every
// Account this Client owns (Account.clientId, see that field's own
// schema comment) -- Live and Demo both, this route doesn't distinguish.
// Also opportunistically checks for a one-time credential reveal left by
// a just-approved LiveAccountRequest (see lib/live-account-credentials.ts)
// so the client sees their new Live account's password here without a
// separate endpoint/round trip.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const [accounts, revealedCredentials] = await Promise.all([
    prisma.account.findMany({
      where: { clientId: session.clientId },
      select: {
        id: true,
        accountNumber: true,
        accountMode: true,
        currency: true,
        leverage: true,
        balance: true,
        status: true,
        accountType: { select: { name: true } },
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    consumeRevealedCredentials(session.clientId),
  ]);

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      accountNumber: a.accountNumber,
      accountMode: a.accountMode,
      accountTypeName: a.accountType?.name ?? null,
      currency: a.currency,
      leverage: a.leverage,
      balance: a.balance.toString(),
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    })),
    revealedCredentials,
  });
}

// Demo accounts are created instantly, self-service -- no KYC, no
// approval queue (see the Live path in app/api/portal/live-account-
// requests/route.ts instead, which IS gated on KYC). Reuses the exact
// same provisioning path as Manager's own Add Account form
// (lib/account-provisioning.ts) with clientId set so it shows up here.
export async function POST(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const { allowed } = await checkRateLimit(`portal-create-demo:${session.clientId}`, 10, 60);
  if (!allowed) {
    return NextResponse.json({ error: "too many attempts, try again shortly" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  if (body?.accountMode !== "DEMO") {
    return NextResponse.json({ error: "only accountMode: \"DEMO\" can be created directly, request a Live account instead" }, { status: 400 });
  }

  const [client, broker] = await Promise.all([
    prisma.client.findUnique({ where: { id: session.clientId } }),
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId } }),
  ]);
  if (!client) {
    return NextResponse.json({ error: "client not found" }, { status: 404 });
  }

  let accountTypeId: string | null = null;
  if (typeof body?.accountTypeId === "string" && body.accountTypeId) {
    const found = await prisma.accountType.findUnique({ where: { id: body.accountTypeId } });
    if (!found || found.brokerId !== session.brokerId || !found.enabled) {
      return NextResponse.json({ error: "account type not found" }, { status: 404 });
    }
    accountTypeId = found.id;
  } else {
    const defaultType = await prisma.accountType.findFirst({ where: { brokerId: session.brokerId, isDefault: true } });
    accountTypeId = defaultType?.id ?? null;
  }

  const defaultGroup = await prisma.group.findFirst({ where: { brokerId: session.brokerId, isDefault: true } });

  const password = generateTemporaryPassword();
  const passwordHash = await hashPassword(password);

  const account = await provisionAccount({
    brokerId: session.brokerId,
    fullName: client.fullName,
    email: client.email,
    passwordHash,
    accountMode: "DEMO",
    accountTypeId,
    currency: broker.defaultAccountCurrency,
    leverage: defaultGroup?.leverage ?? broker.defaultAccountLeverage,
    groupId: defaultGroup?.id ?? null,
    initialBalance: new Prisma.Decimal(0),
    country: client.country,
    phone: client.phone,
    dateOfBirth: client.dateOfBirth,
    clientId: client.id,
    createdByAdminId: null,
  });

  return NextResponse.json(
    {
      accountNumber: account.accountNumber,
      // Shown exactly once -- this response is the only place this
      // plaintext password ever exists; never stored, never emailed for
      // Demo (Live's own flow does email it, since that approval happens
      // out of band from any request this client made themselves).
      password,
    },
    { status: 201 }
  );
}
