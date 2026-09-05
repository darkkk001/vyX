import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

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
//
// Numeric MAX via a raw cast, not `orderBy: { accountNumber: "desc" }` --
// accountNumber is a Prisma String column, so that `desc` sort is
// lexicographic, not numeric. A real incident: a 7-digit, non-zero-
// padded test accountNumber ("9000001") sorted lexicographically ABOVE
// every real 8-digit "5......." number ('9' > '5' as the first
// character), so `findFirst` kept returning that test row as "the
// max" forever -- every subsequent real account creation, for every
// broker, computed the same colliding next number and failed outright
// once nothing was left to retry into. Casting to bigint sidesteps the
// whole class of bug regardless of what shape any future accountNumber
// happens to take (differing digit counts, non-zero-padded values,
// etc.) -- correct by construction, not by convention every writer has
// to remember to uphold.
async function nextAccountNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX("accountNumber"::bigint) as max FROM "Account" WHERE "accountNumber" ~ '^[0-9]+$'
  `;
  const base = rows[0]?.max != null ? Number(rows[0].max) : 50000999;
  return String((Number.isFinite(base) ? base : 50000999) + 1).padStart(8, "0");
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [accounts, mirrorRules] = await Promise.all([
    prisma.account.findMany({
      where: { brokerId: session.brokerId! },
      include: {
        group: { select: { id: true, name: true } },
        ibLinkAsClient: { select: { id: true } },
        kycRecord: { select: { status: true } },
        accountType: { select: { id: true, name: true } },
      },
      orderBy: { accountNumber: "asc" },
    }),
    // Client page's "Mirrored: Reverse x1" badge
    // (docs/briefs/VYX-MIRROR-V0-BRIEF.md) -- only enabled, un-killed rules
    // count as "this account is currently being mirrored."
    prisma.mirrorRule.findMany({
      where: { brokerId: session.brokerId!, enabled: true, killedAt: null },
      select: { sourceType: true, sourceId: true, direction: true, multiplier: true },
    }),
  ]);
  const mirrorByAccountId = new Map(mirrorRules.filter((r) => r.sourceType === "ACCOUNT").map((r) => [r.sourceId, r]));
  const mirrorByGroupId = new Map(mirrorRules.filter((r) => r.sourceType === "GROUP").map((r) => [r.sourceId, r]));

  return NextResponse.json(
    accounts.map((a) => {
      const mirror = mirrorByAccountId.get(a.id) ?? (a.groupId ? mirrorByGroupId.get(a.groupId) : undefined);
      return {
        id: a.id,
        accountNumber: a.accountNumber,
        fullName: a.fullName,
        email: a.email,
        accountMode: a.accountMode,
        accountTypeId: a.accountTypeId,
        accountTypeName: a.accountType?.name ?? null,
        currency: a.currency,
        leverage: a.leverage,
        balance: a.balance.toString(),
        credit: a.credit.toString(),
        status: a.status,
        groupId: a.groupId,
        groupName: a.group?.name ?? null,
        hasIbLink: !!a.ibLinkAsClient,
        maxDailyLoss: a.maxDailyLoss ? a.maxDailyLoss.toString() : null,
        swapFree: a.swapFree,
        country: a.country,
        kycStatus: a.kycRecord?.status ?? null,
        mirror: mirror ? { direction: mirror.direction, multiplier: mirror.multiplier.toString() } : null,
      };
    })
  );
}

// Any MANAGER can onboard a new client -- account creation itself isn't
// gated behind ACCOUNT_FINANCE (unlike PATCH .../[id]/route.ts's
// leverage/status/balance edits on an *existing* account, which stay
// finance-only). But this route can also set a starting balance/custom
// leverage right here, which would otherwise let a Manager without that
// permission route around the balance-adjustment gate entirely by just
// creating a new, pre-funded account -- so a Manager without
// ACCOUNT_FINANCE gets initialBalance forced to 0 and leverage forced to
// the group/broker default, silently ignoring anything else the client
// sent for those two fields specifically. This is also, today, the only
// place a client's country/phone/date of birth can ever be entered --
// there is no self-registration flow anywhere in the app.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    return await createAccount(request, session!);
  } catch (error) {
    // Last-resort safety net -- every validation case above already
    // returns a specific message, so reaching here means something
    // genuinely unexpected happened (e.g. a DB-level rejection this
    // route didn't anticipate). Without this, that error would propagate
    // uncaught and the client would see an opaque failure with no
    // `.error` field, showing only AccountsManager.tsx's generic
    // "failed to create account" fallback -- which is exactly the
    // confusing symptom this replaces.
    console.error("POST /api/manage/accounts failed unexpectedly:", error);
    return NextResponse.json({ error: "unexpected error creating account, please try again" }, { status: 500 });
  }
}

async function createAccount(request: NextRequest, session: NonNullable<Awaited<ReturnType<typeof getAdminSession>>>) {
  const canSetFinancials = session.role === "BROKER_ADMIN" || (await hasPermission(session, "ACCOUNT_FINANCE"));
  const brokerId = session.brokerId!;
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });

  const body = await request.json().catch(() => null);
  const fullName = typeof body?.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  // Renamed from "accountType" -- see prisma/schema.prisma's own comment
  // on AccountMode for why. Still accepts DEMO/LIVE, still required.
  const accountMode = body?.accountMode === "LIVE" ? "LIVE" : body?.accountMode === "DEMO" ? "DEMO" : null;

  if (!fullName || !email || !email.includes("@") || !accountMode) {
    return NextResponse.json({ error: "fullName, a valid email, and accountMode are required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  // AccountType (pricing tier -- Standard/Pro/Zero, see that model's own
  // schema comment) is a SEPARATE choice from accountMode above, per the
  // Add-account form's own field ordering. An explicit accountTypeId
  // must belong to this broker and be enabled (can't assign a disabled
  // type to a new account, same rule AccountType's own schema comment
  // describes for the Settings CRUD page); omitted entirely falls back
  // to the broker's isDefault type, matching the migration's own
  // backfill convention for every pre-existing account.
  let accountTypeId: string | null = null;
  if (typeof body?.accountTypeId === "string" && body.accountTypeId) {
    const found = await prisma.accountType.findUnique({ where: { id: body.accountTypeId } });
    if (!found || found.brokerId !== brokerId || !found.enabled) {
      return NextResponse.json({ error: "account type not found" }, { status: 404 });
    }
    accountTypeId = found.id;
  } else {
    const defaultType = await prisma.accountType.findFirst({ where: { brokerId, isDefault: true } });
    accountTypeId = defaultType?.id ?? null;
  }

  const currency = typeof body?.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : broker.defaultAccountCurrency;
  const country = typeof body?.country === "string" && body.country.trim() ? body.country.trim() : null;
  const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  let dateOfBirth: Date | null = null;
  if (typeof body?.dateOfBirth === "string" && body.dateOfBirth.trim()) {
    const parsed = new Date(body.dateOfBirth);
    // A native <input type="date"> can't hand back a string new Date()
    // fails to parse, but it happily accepts a future date or a
    // 4-digit-year underflow (e.g. year 1) from someone free-typing into
    // the year segment -- reject those explicitly instead of letting a
    // nonsense date reach the database, where it either silently saves
    // or throws an unhandled error the caller never sees a reason for.
    if (isNaN(parsed.getTime()) || parsed > new Date() || parsed.getUTCFullYear() < 1900) {
      return NextResponse.json({ error: "date of birth must be a valid date in the past" }, { status: 400 });
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
  // same rule as PATCH .../[id]/route.ts -- but only for a caller who
  // could also change it after the fact via that same route.
  let leverage = group?.leverage ?? broker.defaultAccountLeverage;
  if (canSetFinancials && body?.leverage != null) {
    const n = Number.isFinite(Number(body.leverage)) ? Math.trunc(Number(body.leverage)) : NaN;
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "leverage must be a positive integer" }, { status: 400 });
    }
    leverage = n;
  }

  let initialBalance: Prisma.Decimal;
  if (canSetFinancials) {
    try {
      initialBalance = new Prisma.Decimal(String(body?.initialBalance ?? "0"));
    } catch {
      return NextResponse.json({ error: "invalid initialBalance" }, { status: 400 });
    }
    if (initialBalance.lt(0)) {
      return NextResponse.json({ error: "initialBalance must not be negative" }, { status: 400 });
    }
  } else {
    initialBalance = new Prisma.Decimal(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
            accountMode,
            accountTypeId,
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
              createdByAdminId: session.adminId,
            },
          });
        }

        await tx.auditLog.create({
          data: {
            brokerId,
            actorAdminId: session.adminId,
            action: "ACCOUNT_CREATED",
            entityType: "Account",
            entityId: account.id,
            oldValue: Prisma.JsonNull,
            newValue: { accountNumber, email, accountMode, accountTypeId, initialBalance: initialBalance.toString() },
          },
        });

        return account;
      });

      return NextResponse.json(
        {
          id: result.id,
          accountNumber: result.accountNumber,
          email: result.email,
          // No password here -- the caller already has it (they just typed
          // it into the form); echoing it back in the response just puts a
          // live credential in the network log/devtools for no benefit.
        },
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Two distinct unique constraints can fire P2002 here --
        // accountNumber (a genuine allocation race, worth retrying with a
        // freshly-read max) vs. the [brokerId, email, accountMode]
        // constraint (a duplicate client, not a race -- retrying would
        // just fail the same way every time and burn all 5 attempts
        // before ever telling the caller why).
        const target = error.meta?.target;
        const fields = Array.isArray(target) ? target.map(String) : typeof target === "string" ? [target] : [];
        const isAccountNumberRace = fields.some((f) => f.toLowerCase().includes("accountnumber"));
        if (isAccountNumberRace && attempt < maxAttempts - 1) {
          continue;
        }
        if (isAccountNumberRace) {
          return NextResponse.json({ error: "could not allocate an account number, please try again" }, { status: 500 });
        }
        return NextResponse.json({ error: "an account with this email already exists for this broker" }, { status: 409 });
      }
      throw error;
    }
  }
  return NextResponse.json({ error: "failed to allocate an account number, try again" }, { status: 500 });
}
