import { NextRequest, NextResponse } from "next/server";
import { Prisma, PaymentMethodType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Every payment method type this platform knows -- same "always show
// every one, saved or not" pattern as app/api/manage/symbols/route.ts's
// own DEFAULTS (see that route's comment): a type with no PaymentMethod
// row yet renders disabled with zero fees/limits rather than being
// absent from the list, so a broker admin can see and turn on every
// option without first knowing this row-per-type model exists.
const ALL_TYPES: PaymentMethodType[] = ["USDT_TRC20", "USDT_BEP20", "BTC", "ETH", "BANK_TRANSFER"];

const DEFAULTS = {
  enabled: false,
  minAmount: "0",
  maxAmount: null as string | null,
  feePercent: "0",
  feeFixed: "0",
  instructions: null as string | null,
  walletAddress: null as string | null,
};

// BROKER_ADMIN only, same carve-out as app/api/manage/settings/route.ts
// (financial config a broker's own team controls, not delegated to
// MANAGER and not Super Admin's job either).
async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const rows = await prisma.paymentMethod.findMany({ where: { brokerId: session.brokerId! } });
  const byType = new Map(rows.map((r) => [r.type, r]));

  return NextResponse.json(
    ALL_TYPES.map((type) => {
      const row = byType.get(type);
      return {
        id: row?.id ?? null,
        type,
        enabled: row ? row.enabled : DEFAULTS.enabled,
        minAmount: row ? row.minAmount.toString() : DEFAULTS.minAmount,
        maxAmount: row ? (row.maxAmount ? row.maxAmount.toString() : null) : DEFAULTS.maxAmount,
        feePercent: row ? row.feePercent.toString() : DEFAULTS.feePercent,
        feeFixed: row ? row.feeFixed.toString() : DEFAULTS.feeFixed,
        instructions: row ? row.instructions : DEFAULTS.instructions,
        walletAddress: row ? row.walletAddress : DEFAULTS.walletAddress,
      };
    })
  );
}

interface PatchBody {
  type: PaymentMethodType;
  enabled: boolean;
  minAmount: string;
  maxAmount: string | null;
  feePercent: string;
  feeFixed: string;
  instructions: string | null;
  walletAddress: string | null;
}

function parseDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const d = new Prisma.Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

export async function PATCH(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Partial<PatchBody> | null;
  if (!body || !ALL_TYPES.includes(body.type as PaymentMethodType)) {
    return NextResponse.json({ error: "type must be one of " + ALL_TYPES.join(", ") }, { status: 400 });
  }

  const minAmount = parseDecimal(body.minAmount);
  const feePercent = parseDecimal(body.feePercent);
  const feeFixed = parseDecimal(body.feeFixed);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
  const maxAmountRaw = body.maxAmount;
  const maxAmount = maxAmountRaw == null || maxAmountRaw === "" ? null : parseDecimal(maxAmountRaw);

  if (!minAmount || !feePercent || !feeFixed || enabled === null) {
    return NextResponse.json({ error: "minAmount, feePercent, feeFixed, and enabled must be valid" }, { status: 400 });
  }
  if (maxAmountRaw != null && maxAmountRaw !== "" && !maxAmount) {
    return NextResponse.json({ error: "maxAmount must be a valid number or empty" }, { status: 400 });
  }
  if (minAmount.lt(0) || feePercent.lt(0) || feeFixed.lt(0)) {
    return NextResponse.json({ error: "minAmount, feePercent, and feeFixed must not be negative" }, { status: 400 });
  }
  if (feePercent.gt(100)) {
    return NextResponse.json({ error: "feePercent must not exceed 100" }, { status: 400 });
  }
  if (maxAmount && maxAmount.lte(0)) {
    return NextResponse.json({ error: "maxAmount must be positive when set" }, { status: 400 });
  }
  if (maxAmount && minAmount.gt(maxAmount)) {
    return NextResponse.json({ error: "minAmount must not be greater than maxAmount" }, { status: 400 });
  }

  const instructions = typeof body.instructions === "string" ? body.instructions.trim().slice(0, 1000) || null : null;
  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress.trim().slice(0, 200) || null : null;

  const data = { enabled, minAmount, maxAmount, feePercent, feeFixed, instructions, walletAddress };

  const saved = await prisma.paymentMethod.upsert({
    where: { brokerId_type: { brokerId: session.brokerId!, type: body.type as PaymentMethodType } },
    create: { brokerId: session.brokerId!, type: body.type as PaymentMethodType, ...data },
    update: data,
  });

  return NextResponse.json({
    id: saved.id,
    type: saved.type,
    enabled: saved.enabled,
    minAmount: saved.minAmount.toString(),
    maxAmount: saved.maxAmount ? saved.maxAmount.toString() : null,
    feePercent: saved.feePercent.toString(),
    feeFixed: saved.feeFixed.toString(),
    instructions: saved.instructions,
    walletAddress: saved.walletAddress,
  });
}
