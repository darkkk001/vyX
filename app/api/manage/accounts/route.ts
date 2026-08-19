import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Sequential 8-digit MT-style login id (matches the seeded demo accounts'
// shape, e.g. "50001234"). accountNumber is globally unique (not
// broker-scoped) so this reads the current global max, not just this
// broker's. A race between two concurrent creates is handled by retrying
// on the unique-constraint error in the POST handler below, same idiom as
// app/api/trade/orders/route.ts's idempotency-key retry.
async function nextAccountNumber(): Promise<string> {
  const last = await prisma.account.findFirst({ orderBy: { accountNumber: "desc" }, select: { accountNumber: true } });
  const base = last ? parseInt(last.accountNumber, 10) : 50000999;
  return String((Number.isFinite(base) ? base : 50000999) + 1).padStart(8, "0");
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const accounts = await prisma.account.findMany({
    where: { brokerId: session.brokerId! },
    include: { group: { select: { id: true, name: true } } },
    orderBy: { accountNumber: "asc" },
  });

  return NextResponse.json(
    accounts.map((a) => ({
      id: a.id,
      accountNumber: a.accountNumber,
      fullName: a.fullName,
      email: a.email,
      accountType: a.accountType,
      currency: a.currency,
      leverage: a.leverage,
      balance: a.balance.toString(),
      credit: a.credit.toString(),
      status: a.status,
      groupId: a.groupId,
      groupName: a.group?.name ?? null,
    }))
  );
}

// BROKER_ADMIN only -- creating a funded account is finance-adjacent,
// same split PATCH .../[id]/route.ts already applies (MANAGER only
// touches groupId there). This is also, today, the *only* place a
// client's country/phone/date of birth can ever be entered -- there is
// no self-registration flow anywhere in the app.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const body = await request.json().catch(() => null);
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const accountType = body?.accountType === "LIVE" ? "LIVE" : body?.accountType === "DEMO" ? "DEMO" : null;

  if (!fullName || !email || !email.includes("@") || !accountType) {
    return NextResponse.json({ error: "fullName, a valid email, and accountType are required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const currency = typeof body?.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "USD";
  const country = typeof body?.country === "string" && body.country.trim() ? body.country.trim() : null;
  const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  let dateOfBirth: Date | null = null;
  if (typeof body?.dateOfBirth === "string" && body.dateOfBirth.trim()) {
    const parsed = new Date(body.dateOfBirth);
    if (isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "invalid dateOfBirth" }, { status: 400 });
    }
    dateOfBirth = parsed;
  }

  let group: { id: string; leverage: number } | null = null;
  if (typeof body?.groupId === "string" && body.groupId) {
    const found = await prisma.group.findUnique({ where: { id: body.groupId } });
    if (!found || found.brokerId !== brokerId) {
      return NextResponse.json({ error: "group not found" }, { status: 404 });
    }
    group = { id: found.id, leverage: found.leverage };
  }

  // An explicit leverage always wins over a group's copied-down value,
  // same rule as PATCH .../[id]/route.ts.
  let leverage = group?.leverage ?? 100;
  if (body?.leverage != null) {
    const n = Number.isFinite(Number(body.leverage)) ? Math.trunc(Number(body.leverage)) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "leverage must be a positive integer" }, { status: 400 });
    }
    leverage = n;
  }

  let initialBalance: Prisma.Decimal;
  try {
    initialBalance = new Prisma.Decimal(String(body?.initialBalance ?? "0"));
  } catch {
    return NextResponse.json({ error: "invalid initialBalance" }, { status: 400 });
  }
  if (initialBalance.lt(0)) {
    return NextResponse.json({ error: "initialBalance must not be negative" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  for (let attempt = 0; attempt < 2; attempt++) {
    const accountNumber = await nextAccountNumber();
    try {
      const result = await prisma.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: {
            brokerId,
            accountNumber,
            email,
            passwordHash,
            fullName,
            accountType,
            currency,
            leverage,
            groupId: group?.id ?? null,
            country,
            phone,
            dateOfBirth,
          },
        });

        if (initialBalance.gt(0)) {
          await tx.account.update({ where: { id: account.id }, data: { balance: initialBalance } });
          await tx.transaction.create({
            data: {
              brokerId,
              accountId: account.id,
              type: "ADJUSTMENT",
              status: "COMPLETED",
              amount: initialBalance,
              balanceBefore: new Prisma.Decimal(0),
              balanceAfter: initialBalance,
              note: "Initial balance on account creation",
              createdByAdminId: session!.adminId,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            brokerId,
            actorAdminId: session!.adminId,
            action: "ACCOUNT_CREATED",
            entityType: "Account",
            entityId: account.id,
            oldValue: Prisma.JsonNull,
            newValue: { accountNumber, email, accountType, initialBalance: initialBalance.toString() },
          },
        });

        return account;
      });

      return NextResponse.json(
        {
          id: result.id,
          accountNumber: result.accountNumber,
          email: result.email,
          password, // shown once -- only the hash is stored, this response is the only chance to see it
        },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt === 0) {
        continue; // accountNumber race -- retry once with a freshly-read max
      }
      throw error;
    }
  }
  return NextResponse.json({ error: "failed to allocate an account number, try again" }, { status: 500 });
}
