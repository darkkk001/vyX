import { NextRequest, NextResponse } from "next/server";
import { Prisma, TradingMode, BookType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const TRADING_MODES: TradingMode[] = ["BOTH", "BUY_ONLY", "SELL_ONLY"];
const BOOK_TYPES: BookType[] = ["A_BOOK", "B_BOOK"];

// BrokerSymbol's own schema defaults (prisma/schema.prisma) -- mirrored
// here so a symbol with no configured row yet still displays real,
// in-effect values instead of blanks. Same "missing config = defaults"
// convention already established in engine/order-management/src/db.rs's
// get_broker_symbol_config, kept in sync deliberately: whatever this
// screen shows for an unconfigured symbol is exactly what the Rust
// engine will actually apply if that symbol trades before anyone edits it.
const DEFAULTS = {
  spreadMarkup: "0",
  minLot: "0.01",
  maxLot: "100",
  lotStep: "0.01",
  swapLong: "0",
  swapShort: "0",
  enabled: true,
  commissionPerLot: "0",
  maxExposure: null as string | null,
  tradingMode: "BOTH" as TradingMode,
  defaultBookType: "B_BOOK" as BookType,
};

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const symbols = await prisma.symbol.findMany({
    orderBy: { name: "asc" },
    include: { brokerSymbols: { where: { brokerId: session.brokerId! } } },
  });

  const rows = symbols.map((symbol) => {
    const cfg = symbol.brokerSymbols[0];
    return {
      symbolId: symbol.id,
      symbolName: symbol.name,
      category: symbol.category,
      digits: symbol.digits,
      spreadMarkup: cfg ? cfg.spreadMarkup.toString() : DEFAULTS.spreadMarkup,
      minLot: cfg ? cfg.minLot.toString() : DEFAULTS.minLot,
      maxLot: cfg ? cfg.maxLot.toString() : DEFAULTS.maxLot,
      lotStep: cfg ? cfg.lotStep.toString() : DEFAULTS.lotStep,
      swapLong: cfg ? cfg.swapLong.toString() : DEFAULTS.swapLong,
      swapShort: cfg ? cfg.swapShort.toString() : DEFAULTS.swapShort,
      enabled: cfg ? cfg.enabled : DEFAULTS.enabled,
      commissionPerLot: cfg ? cfg.commissionPerLot.toString() : DEFAULTS.commissionPerLot,
      maxExposure: cfg ? (cfg.maxExposure ? cfg.maxExposure.toString() : null) : DEFAULTS.maxExposure,
      tradingMode: cfg ? cfg.tradingMode : DEFAULTS.tradingMode,
      defaultBookType: cfg ? cfg.defaultBookType : DEFAULTS.defaultBookType,
    };
  });

  return NextResponse.json(rows);
}

interface PatchBody {
  symbolId: string;
  spreadMarkup: string;
  minLot: string;
  maxLot: string;
  lotStep: string;
  swapLong: string;
  swapShort: string;
  enabled: boolean;
  commissionPerLot: string;
  maxExposure: string | null;
  tradingMode: TradingMode;
  defaultBookType: BookType;
}

// Decimal.js isn't a dependency of this app (only services/api-gateway
// has it) -- Prisma.Decimal is already available via @prisma/client and
// is the same underlying decimal.js instance Prisma itself uses for
// Decimal columns, so validating with it here stays consistent with how
// every other Decimal field in this app is parsed (see lib/trading.ts).
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
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Partial<PatchBody> | null;
  const symbolId = typeof body?.symbolId === "string" ? body.symbolId : "";
  if (!symbolId) {
    return NextResponse.json({ error: "symbolId is required" }, { status: 400 });
  }

  const symbol = await prisma.symbol.findUnique({ where: { id: symbolId } });
  if (!symbol) {
    return NextResponse.json({ error: "unknown symbolId" }, { status: 400 });
  }

  const spreadMarkup = parseDecimal(body?.spreadMarkup);
  const minLot = parseDecimal(body?.minLot);
  const maxLot = parseDecimal(body?.maxLot);
  const lotStep = parseDecimal(body?.lotStep);
  const swapLong = parseDecimal(body?.swapLong);
  const swapShort = parseDecimal(body?.swapShort);
  const commissionPerLot = parseDecimal(body?.commissionPerLot);
  const maxExposureRaw = body?.maxExposure;
  const maxExposure = maxExposureRaw == null || maxExposureRaw === "" ? null : parseDecimal(maxExposureRaw);
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
  const tradingMode = TRADING_MODES.includes(body?.tradingMode as TradingMode) ? (body!.tradingMode as TradingMode) : null;
  const defaultBookType = BOOK_TYPES.includes(body?.defaultBookType as BookType) ? (body!.defaultBookType as BookType) : null;

  if (
    !spreadMarkup ||
    !minLot ||
    !maxLot ||
    !lotStep ||
    !swapLong ||
    !swapShort ||
    !commissionPerLot ||
    enabled === null ||
    tradingMode === null ||
    defaultBookType === null
  ) {
    return NextResponse.json({ error: "all fields must be valid numbers/booleans/tradingMode/defaultBookType" }, { status: 400 });
  }
  if (maxExposureRaw != null && maxExposureRaw !== "" && !maxExposure) {
    return NextResponse.json({ error: "maxExposure must be a valid number or empty" }, { status: 400 });
  }
  if (minLot.lte(0) || maxLot.lte(0) || lotStep.lte(0)) {
    return NextResponse.json({ error: "minLot, maxLot, and lotStep must be positive" }, { status: 400 });
  }
  if (minLot.gt(maxLot)) {
    return NextResponse.json({ error: "minLot must not be greater than maxLot" }, { status: 400 });
  }
  if (spreadMarkup.lt(0) || commissionPerLot.lt(0)) {
    return NextResponse.json({ error: "spreadMarkup and commissionPerLot must not be negative" }, { status: 400 });
  }
  if (maxExposure && maxExposure.lte(0)) {
    return NextResponse.json({ error: "maxExposure must be positive when set" }, { status: 400 });
  }

  const brokerId = session.brokerId!;

  const existing = await prisma.brokerSymbol.findUnique({
    where: { brokerId_symbolId: { brokerId, symbolId } },
  });

  const data = {
    spreadMarkup,
    minLot,
    maxLot,
    lotStep,
    swapLong,
    swapShort,
    enabled,
    commissionPerLot,
    maxExposure,
    tradingMode,
    defaultBookType,
  };

  const updated = await prisma.brokerSymbol.upsert({
    where: { brokerId_symbolId: { brokerId, symbolId } },
    create: { brokerId, symbolId, ...data },
    update: data,
  });

  await prisma.auditLog.create({
    data: {
      brokerId,
      actorAdminId: session.adminId,
      action: "SYMBOL_CONFIG_UPDATED",
      entityType: "BrokerSymbol",
      entityId: updated.id,
      oldValue: existing
        ? {
            spreadMarkup: existing.spreadMarkup.toString(),
            minLot: existing.minLot.toString(),
            maxLot: existing.maxLot.toString(),
            lotStep: existing.lotStep.toString(),
            swapLong: existing.swapLong.toString(),
            swapShort: existing.swapShort.toString(),
            enabled: existing.enabled,
            commissionPerLot: existing.commissionPerLot.toString(),
            maxExposure: existing.maxExposure?.toString() ?? null,
            tradingMode: existing.tradingMode,
            defaultBookType: existing.defaultBookType,
          }
        : DEFAULTS,
      newValue: {
        spreadMarkup: updated.spreadMarkup.toString(),
        minLot: updated.minLot.toString(),
        maxLot: updated.maxLot.toString(),
        lotStep: updated.lotStep.toString(),
        swapLong: updated.swapLong.toString(),
        swapShort: updated.swapShort.toString(),
        enabled: updated.enabled,
        commissionPerLot: updated.commissionPerLot.toString(),
        maxExposure: updated.maxExposure?.toString() ?? null,
        tradingMode: updated.tradingMode,
        defaultBookType: updated.defaultBookType,
      },
    },
  });

  return NextResponse.json({
    symbolId: updated.symbolId,
    spreadMarkup: updated.spreadMarkup.toString(),
    minLot: updated.minLot.toString(),
    maxLot: updated.maxLot.toString(),
    lotStep: updated.lotStep.toString(),
    swapLong: updated.swapLong.toString(),
    swapShort: updated.swapShort.toString(),
    enabled: updated.enabled,
    commissionPerLot: updated.commissionPerLot.toString(),
    maxExposure: updated.maxExposure?.toString() ?? null,
    tradingMode: updated.tradingMode,
    defaultBookType: updated.defaultBookType,
  });
}
