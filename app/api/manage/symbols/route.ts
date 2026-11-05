import { NextRequest, NextResponse } from "next/server";
import { displayCurrency } from "@/lib/demo-policy";
import { symbolHiddenFromBroker, symbolVisibility } from "@/lib/synthetic-symbols";
import { missingForSymbol } from "@/lib/symbol-completeness";
import { withConfigEvent } from "@/lib/config-events";
import { Prisma, TradingMode, BookType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getLivePriceRows } from "@/lib/live-price";
import { symbolSlippageCapPoints } from "@/lib/slippage-cap";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { hoursSummary, validateSessions } from "@/lib/symbol-sessions";
import { CORE_KEYS, EXTRA_KEYS, closeOnlyRefusal, crossCheck, fieldsView, parseSymbolFields, symbolWriteRefusal } from "@/lib/symbol-config";
import { createBrokerSymbol, readSessions } from "@/lib/symbol-write";

const TRADING_MODES: TradingMode[] = ["BOTH", "BUY_ONLY", "SELL_ONLY", "CLOSE_ONLY"];
const BOOK_TYPES: BookType[] = ["A_BOOK", "B_BOOK"];

// BrokerSymbol's own schema defaults (prisma/schema.prisma) -- mirrored
// here so a symbol with no configured row yet still displays real,
// in-effect values instead of blanks. Same "missing config = defaults"
// convention already established in engine/order-management/src/db.rs's
// get_broker_symbol_config, kept in sync deliberately: whatever this
// screen shows for an unconfigured symbol is exactly what the Rust
// engine will actually apply if that symbol trades before anyone edits it.
// Hedged margin: values below this need an explicit confirmation (see PATCH).
const HEDGED_MARGIN_FLOOR_PCT = 50;

const DEFAULTS = {
  spreadMarkup: "0",
  minLot: "0.01",
  maxLot: "100",
  lotStep: "0.01",
  swapLong: "0",
  swapShort: "0",
  // a symbol with no BrokerSymbol row is NOT enabled: trading (app/api/trade/symbols) and the group counts only count real enabled rows
  enabled: false,
  commissionPerLot: "0",
  maxExposure: null as string | null,
  tradingMode: "BOTH" as TradingMode,
  defaultBookType: "B_BOOK" as BookType,
  hedgedMarginPct: "200",
  stopLevel: 0,
};

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// effectiveMaxSlippagePoints: the cap a fill on this symbol gets right now, in its points (null = no cap, or no live
// price to derive it from); slippageCapSource: "symbol" (its own value) or "derived" (from the broker's XAUUSD base)
function effectiveCap(
  broker: { slippageCapXauPoints: Prisma.Decimal | null; slippageCapRefPrice: Prisma.Decimal | null },
  symbol: { name: string; digits: number },
  own: Prisma.Decimal | null,
  live: { bid: Prisma.Decimal; ask: Prisma.Decimal } | undefined
) {
  if (own != null) return { effectiveMaxSlippagePoints: own.toString(), slippageCapSource: "symbol" as const };
  const cap = live ? symbolSlippageCapPoints(broker, { name: symbol.name, digits: symbol.digits }, live.ask) : null;
  return { effectiveMaxSlippagePoints: cap ? cap.toString() : null, slippageCapSource: "derived" as const };
}

export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const [allSymbols, visible] = await Promise.all([
    prisma.symbol.findMany({
      orderBy: { name: "asc" },
      include: { brokerSymbols: { where: { brokerId: session.brokerId! }, include: { tradingSessions: { orderBy: [{ dayOfWeek: "asc" }, { openTime: "asc" }] } } } },
    }),
    symbolVisibility(prisma, session.brokerId!),
  ]);
  // synthetic symbols (lib/synthetic-symbols.ts) exist for the shadow-bot tenant only, the demo's q-symbols for the demo tenant
  // only: hidden from every other broker
  const symbols = allSymbols.filter((s) => visible(s.name));
  // the effective slippage cap per symbol is the server's number (owner rule: no app computes it): the broker's base,
  // its gold reference and each added symbol's live price, one batched read (a symbol with no price shows no figure)
  const symbolIds = symbols.filter((s) => s.brokerSymbols[0]).map((s) => s.id);
  const [capBroker, capPrices, lpRules, lpConns] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId! }, select: { slippageCapXauPoints: true, slippageCapRefPrice: true, timeZone: true } }),
    getLivePriceRows(symbols.filter((s) => s.brokerSymbols[0]).map((s) => s.name)).catch(() => new Map()),
    // price source / LP mapping per symbol: the existing routing rules and connection symbols, read-only
    prisma.lpRoutingRule.findMany({ where: { brokerId: session.brokerId!, symbolId: { in: symbolIds } }, include: { liquidityProvider: { select: { name: true } } }, orderBy: [{ priority: "asc" }] }),
    prisma.lpConnectionSymbol.findMany({ where: { symbolId: { in: symbolIds }, lpConnection: { brokerId: session.brokerId! } }, include: { lpConnection: { select: { id: true, role: true, enabled: true, liquidityProvider: { select: { name: true } } } } } }),
  ]);

  const rows = symbols.map((symbol) => {
    const cfg = symbol.brokerSymbols[0];
    const sessionRows = cfg ? cfg.tradingSessions.map((s) => ({ kind: s.kind, dayOfWeek: s.dayOfWeek, openTime: s.openTime, closeTime: s.closeTime })) : [];
    const view = cfg ? fieldsView(cfg) : null;
    return {
      symbolId: symbol.id,
      brokerSymbolId: cfg ? cfg.id : null,
      symbolName: symbol.name,
      category: symbol.category,
      digits: symbol.digits,
      // bo 1.0.101 item 3: the catalogue fields the Symbols list shows (read-only; the Symbol row owns them)
      contractSize: symbol.contractSize.toString(),
      baseCurrency: symbol.baseCurrency,
      quoteCurrency: symbol.quoteCurrency,
      spreadMarkup: cfg ? cfg.spreadMarkup.toString() : DEFAULTS.spreadMarkup,
      minLot: cfg ? cfg.minLot.toString() : DEFAULTS.minLot,
      maxLot: cfg ? cfg.maxLot.toString() : DEFAULTS.maxLot,
      lotStep: cfg ? cfg.lotStep.toString() : DEFAULTS.lotStep,
      swapLong: cfg ? cfg.swapLong.toString() : DEFAULTS.swapLong,
      swapShort: cfg ? cfg.swapShort.toString() : DEFAULTS.swapShort,
      enabled: cfg ? cfg.enabled : DEFAULTS.enabled,
      // 1.0.72 round 2: the screen's truth. added = this broker has a BrokerSymbol row (switching ON creates it through PATCH);
      // supported = PATCH would let it be enabled (P/L is USD only until currency conversion exists, see the guard in PATCH).
      added: !!cfg,
      supported: symbol.quoteCurrency === "USD",
      commissionPerLot: cfg ? cfg.commissionPerLot.toString() : DEFAULTS.commissionPerLot,
      maxExposure: cfg ? (cfg.maxExposure ? cfg.maxExposure.toString() : null) : DEFAULTS.maxExposure,
      tradingMode: cfg ? cfg.tradingMode : DEFAULTS.tradingMode,
      defaultBookType: cfg ? cfg.defaultBookType : DEFAULTS.defaultBookType,
      hedgedMarginPct: cfg ? cfg.hedgedMarginPct.toString() : DEFAULTS.hedgedMarginPct,
      // Phase 2 batch 8 (issue 188): minimum SL/TP distance from the price, in points (validateSlTp); 0 = none
      stopLevel: cfg ? cfg.stopLevel : DEFAULTS.stopLevel,
      // Slippage cap (owner 2026-10-26, lib/slippage-cap.ts): this symbol's own cap in its points; null = derived from the
      // broker's XAUUSD base (GET /api/manage/risk slippageCapXauPoints / slippageCapRefPrice)
      maxSlippagePoints: cfg?.maxSlippagePoints != null ? cfg.maxSlippagePoints.toString() : null,
      ...effectiveCap(capBroker, symbol, cfg?.maxSlippagePoints ?? null, capPrices.get(symbol.name)),
      // Step 2 (owner 2026-09-30): how many trading-hours rows this broker has for the symbol (0 = the default week),
      // so SYM's hours summary needs no per-symbol sessions read.
      sessionCount: sessionRows.length,
      // Symbols tab (backoffice 1.0.101): the new settings, null = not set (the UI shows "Not set"); never derived in the app
      ...Object.fromEntries(EXTRA_KEYS.map((k) => [k, view ? view[k] : null])),
      // the configured windows (kind TRADE / QUOTE, UTC) and the server-built hours line, in the broker's zone (null = UTC)
      sessions: sessionRows,
      hoursSummary: hoursSummary(sessionRows, { category: symbol.category, timeZone: capBroker.timeZone }),
      timeZone: capBroker.timeZone,
      lpRouting: lpRules
        .filter((r) => r.symbolId === symbol.id)
        .map((r) => ({ ruleId: r.id, liquidityProviderId: r.liquidityProviderId, liquidityProviderName: r.liquidityProvider.name, groupId: r.groupId, priority: r.priority, weight: r.weight.toString(), enabled: r.enabled })),
      lpConnections: lpConns
        .filter((c) => c.symbolId === symbol.id)
        .map((c) => ({ lpConnectionId: c.lpConnection.id, liquidityProviderName: c.lpConnection.liquidityProvider.name, role: c.lpConnection.role, enabled: c.lpConnection.enabled, venueId: c.venueId })),
      // hotfix 2026-10-08 (lib/symbol-completeness.ts): what this symbol still needs before it can trade, in plain words ([] = complete)
      missing: cfg ? missingForSymbol({ symbol, brokerSymbol: cfg }) : [],
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

// 2026-09-05 real bug fixed here: leaving spreadMarkup/swapLong/
// swapShort/commissionPerLot blank (choosing "no markup/no swap/no
// commission") got a bare "must be a valid number" error -- blank means
// zero for these four. Deliberately NOT used for minLot/maxLot/lotStep:
// those have no sensible "blank means zero" meaning (a 0 lot step is
// nonsensical config, not a valid default), so they stay on the strict
// parser below.
function parseDecimalOrZero(value: unknown): Prisma.Decimal | null {
  if (value == null || value === "") return new Prisma.Decimal(0);
  return parseDecimal(value);
}

async function patchHandler(request: NextRequest) {
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
  // a synthetic symbol is refused exactly like an unknown one for every broker but the shadow-bot tenant
  if (!symbol || (await symbolHiddenFromBroker(prisma, session.brokerId!, symbol.name))) {
    return NextResponse.json({ error: "unknown symbolId" }, { status: 400 });
  }

  // owner decision 2026-09-25 (audit Batch 4, line 16): spread markup, commission, swaps and hedged margin need PRICING
  // (BROKER_ADMIN, or a MANAGER granted it). Only when one of them actually changes: the form resends every field,
  // so editing lot sizes stays open to any MANAGER (disabling a symbol needs EMERGENCY_CONTROLS, below).
  {
    const current = await prisma.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId: session.brokerId!, symbolId } } });
    const num = (v: unknown) => {
      try {
        return v === undefined || v === null || v === "" ? null : new Prisma.Decimal(String(v));
      } catch {
        return null;
      }
    };
    const differs = (sent: unknown, stored: Prisma.Decimal | null | undefined) => {
      if (sent === undefined) return false;
      const a = num(sent) ?? new Prisma.Decimal(0);
      return !a.equals(stored ?? new Prisma.Decimal(0));
    };
    const b = body as Record<string, unknown>;
    const pricingChanged =
      differs(b.spreadMarkup, current?.spreadMarkup) ||
      differs(b.commissionPerLot, current?.commissionPerLot) ||
      differs(b.swapLong, current?.swapLong) ||
      differs(b.swapShort, current?.swapShort) ||
      (b.hedgedMarginPct !== undefined && differs(b.hedgedMarginPct, current?.hedgedMarginPct ?? new Prisma.Decimal(200)));
    if (pricingChanged && (await forbidUnlessBrokerAdminOrPermission(session, "PRICING"))) {
      return NextResponse.json({ error: "forbidden", permission: "PRICING", permissionLabel: PERMISSION_LABELS.PRICING }, { status: 403 });
    }
    // web3 (issues.md 117/198, owner 2026-09-30): turning a symbol off (or back on) is an emergency control, the same
    // gate as a group halt (groups/[id]/halt) and a broker halt (risk PATCH tradingHalted): BROKER_ADMIN or a MANAGER
    // with EMERGENCY_CONTROLS. Only when `enabled` actually changes (a symbol with no row yet counts as enabled), so
    // any MANAGER can still save the rest of the form as before.
    const enabledChanged = typeof b.enabled === "boolean" && b.enabled !== (current?.enabled ?? DEFAULTS.enabled);
    if (enabledChanged && (await forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS"))) {
      return NextResponse.json({ error: "forbidden", permission: "EMERGENCY_CONTROLS", permissionLabel: PERMISSION_LABELS.EMERGENCY_CONTROLS }, { status: 403 });
    }
    // web security batch 1 S2 / S3 (owner 2026-10-29): every other symbol setting (lots, slippage cap, exposure, trading mode, book, stop level)
    // needs "Edit groups / symbols"; pricing keeps PRICING and enabling keeps EMERGENCY_CONTROLS, so a pricing-only save never needs it
    const configChanged =
      differs(b.minLot, current?.minLot) || differs(b.maxLot, current?.maxLot) || differs(b.lotStep, current?.lotStep) ||
      (b.maxExposure !== undefined && differs(b.maxExposure, current?.maxExposure)) ||
      (b.stopLevel !== undefined && Number(b.stopLevel ?? 0) !== Number(current?.stopLevel ?? 0)) ||
      ("maxSlippagePoints" in b && differs(b.maxSlippagePoints, current?.maxSlippagePoints)) ||
      (typeof b.tradingMode === "string" && b.tradingMode !== (current?.tradingMode ?? "BOTH")) ||
      (typeof b.defaultBookType === "string" && b.defaultBookType !== (current?.defaultBookType ?? null));
    if (configChanged && (await forbidUnlessBrokerAdminOrPermission(session, "GROUPS_SYMBOLS"))) {
      return NextResponse.json({ error: "forbidden", permission: "GROUPS_SYMBOLS", permissionLabel: PERMISSION_LABELS.GROUPS_SYMBOLS }, { status: 403 });
    }
  }

  const spreadMarkup = parseDecimalOrZero(body?.spreadMarkup);
  const minLot = parseDecimal(body?.minLot);
  const maxLot = parseDecimal(body?.maxLot);
  const lotStep = parseDecimal(body?.lotStep);
  const swapLong = parseDecimalOrZero(body?.swapLong);
  const swapShort = parseDecimalOrZero(body?.swapShort);
  const commissionPerLot = parseDecimalOrZero(body?.commissionPerLot);
  // this symbol's own slippage cap in points (lib/slippage-cap.ts): not sent = unchanged, blank / null = derived, else > 0
  let maxSlippagePoints: Prisma.Decimal | null | undefined = undefined;
  if (body && "maxSlippagePoints" in body) {
    const raw = body.maxSlippagePoints;
    if (raw === null || raw === "") maxSlippagePoints = null;
    else {
      const v = parseDecimal(raw);
      if (!v || v.lte(0)) return NextResponse.json({ error: "maxSlippagePoints must be a positive number or blank" }, { status: 400 });
      maxSlippagePoints = v;
    }
  }
  const maxExposureRaw = body?.maxExposure;
  const maxExposure = maxExposureRaw == null || maxExposureRaw === "" ? null : parseDecimal(maxExposureRaw);
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : null;
  // Symbols tab (1.0.101) fields, all optional: not sent = unchanged, null / "" = cleared (no value = not set)
  const extras = parseSymbolFields((body ?? {}) as Record<string, unknown>, EXTRA_KEYS);
  if (extras.errors.length > 0) {
    return NextResponse.json({ error: extras.errors.map((e) => `${e.field} ${e.reason}`).join("; "), fieldErrors: extras.errors }, { status: 400 });
  }
  const tradingMode = TRADING_MODES.includes(body?.tradingMode as TradingMode) ? (body!.tradingMode as TradingMode) : null;
  // OPTIONAL as of Stage 4 piece 5. Routing is decided by the account's group
  // (Group.category), never per symbol, so backoffice 1.0.10 stopped sending
  // this. A 1.0.9 still in the field DOES send it and is still honoured --
  // the column survives until Stage 5 precisely so a rollback has its value.
  // null here means "not sent", which is not the same as invalid: it leaves
  // the stored value alone rather than rewriting it.
  const defaultBookType = BOOK_TYPES.includes(body?.defaultBookType as BookType) ? (body!.defaultBookType as BookType) : null;
  // MT5 hedged margin (2026-09-25), OPTIONAL: not sent = the stored value stays (a client that does not know the field
  // never resets it). 0-200: % of one lot's margin charged per hedged BUY+SELL lot pair; 200 = no reduction.
  const hedgedMarginPctRaw = (body as Record<string, unknown> | null)?.hedgedMarginPct;
  const hedgedMarginPct = hedgedMarginPctRaw == null || hedgedMarginPctRaw === "" ? null : parseDecimal(hedgedMarginPctRaw);
  if (hedgedMarginPctRaw != null && hedgedMarginPctRaw !== "" && (!hedgedMarginPct || hedgedMarginPct.lt(0) || hedgedMarginPct.gt(200))) {
    return NextResponse.json({ error: "hedgedMarginPct must be a number from 0 to 200 (200 = hedged positions pay full margin on both legs)" }, { status: 400 });
  }
  // Floor (owner decision 2026-09-25): 50-200 freely; BELOW 50 only with an explicit confirmation. At 0 a fully hedged
  // account has no used margin, so no margin level: it is never stopped out, even at negative equity (a broker loss
  // risk). And under the MT5 largest-loss rule, closing a hedge leg can unhedge the book and cascade into more closes.
  const confirmBelowFloor = (body as Record<string, unknown> | null)?.confirmBelowFloor === true;
  if (hedgedMarginPct && hedgedMarginPct.lt(HEDGED_MARGIN_FLOOR_PCT) && !confirmBelowFloor) {
    const existingPct = (await prisma.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId: session.brokerId!, symbolId } }, select: { hedgedMarginPct: true } }))?.hedgedMarginPct;
    // a save that merely re-sends an already confirmed value (another field edited) is not a new decision
    if (!existingPct || !existingPct.equals(hedgedMarginPct)) {
      return NextResponse.json(
        {
          error: `hedgedMarginPct below ${HEDGED_MARGIN_FLOOR_PCT} needs explicit confirmation (confirmBelowFloor): at 0 a fully hedged account is never stopped out, even at negative equity, and a stop-out can unhedge the book and cascade`,
          code: "HEDGED_MARGIN_BELOW_FLOOR",
        },
        { status: 400 }
      );
    }
  }

  // Phase 2 batch 8 (issue 188) stop level, OPTIONAL like hedgedMarginPct: not sent = the stored value stays (an older
  // backoffice never resets it). A whole number of points, 0 (no minimum) to 100000.
  const stopLevelRaw = (body as Record<string, unknown> | null)?.stopLevel;
  let stopLevel: number | null = null;
  if (stopLevelRaw != null && stopLevelRaw !== "") {
    const n = typeof stopLevelRaw === "number" ? stopLevelRaw : typeof stopLevelRaw === "string" && /^\d+$/.test(stopLevelRaw.trim()) ? Number(stopLevelRaw.trim()) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 100000) {
      return NextResponse.json({ error: "stopLevel must be a whole number of points from 0 to 100000 (0 = no minimum SL/TP distance)" }, { status: 400 });
    }
    stopLevel = n;
  }

  if (
    !spreadMarkup ||
    !minLot ||
    !maxLot ||
    !lotStep ||
    !swapLong ||
    !swapShort ||
    !commissionPerLot ||
    enabled === null ||
    tradingMode === null
  ) {
    return NextResponse.json({ error: "all fields must be valid numbers/booleans/tradingMode" }, { status: 400 });
  }
  if (closeOnlyRefusal(tradingMode)) {
    return NextResponse.json({ error: closeOnlyRefusal(tradingMode), fieldErrors: [{ field: "tradingMode", reason: closeOnlyRefusal(tradingMode) }] }, { status: 400 });
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
  // 2026-09-06 interim guard (Section B audit finding #2) -- the flip side
  // of the account-currency guard in app/api/manage/accounts/route.ts.
  // Every P/L/margin/swap/commission formula credits its result straight
  // onto Account.balance with no currency conversion; that's only correct
  // when a symbol's quote currency matches the account's own (today,
  // always USD). Enabling a non-USD-quoted symbol (e.g. USDJPY, EURGBP)
  // for real trading would silently mis-credit every fill 1:1. Real
  // conversion is a Phase 2 roadmap item -- block enabling until then.
  // Only gates the transition to enabled=true, so a broker can still
  // edit/leave-disabled a non-USD symbol's other config.
  if (enabled && symbol.quoteCurrency !== "USD") {
    return NextResponse.json(
      {
        error: `${symbol.name} cannot be enabled yet: P/L in ${displayCurrency(symbol.quoteCurrency)} is not supported.`,
      },
      { status: 400 }
    );
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
    // Omitted entirely when not sent: Prisma leaves the stored column untouched
    // on update, and applies the schema default (B_BOOK) on create. Writing a
    // fallback here instead would silently re-book an A_BOOK symbol the first
    // time a 1.0.10 saved any unrelated field on it.
    ...(defaultBookType === null ? {} : { defaultBookType }),
    ...(hedgedMarginPct === null ? {} : { hedgedMarginPct }),
    ...(stopLevel === null ? {} : { stopLevel }),
    // optional: blank / null = back to the value derived from the broker's base; not sent = unchanged
    ...(maxSlippagePoints === undefined ? {} : { maxSlippagePoints }),
    ...extras.data,
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
            hedgedMarginPct: existing.hedgedMarginPct.toString(),
            stopLevel: existing.stopLevel,
            ...extraSnapshot(existing),
          }
        : { ...DEFAULTS, ...extraSnapshot(null) },
      newValue: {
        spreadMarkup: updated.spreadMarkup.toString(),
        minLot: updated.minLot.toString(),
        maxLot: updated.maxLot.toString(),
        lotStep: updated.lotStep.toString(),
        swapLong: updated.swapLong.toString(),
        swapShort: updated.swapShort.toString(),
        enabled: updated.enabled,
        commissionPerLot: updated.commissionPerLot.toString(),
        maxSlippagePoints: updated.maxSlippagePoints != null ? updated.maxSlippagePoints.toString() : null,
        maxExposure: updated.maxExposure?.toString() ?? null,
        tradingMode: updated.tradingMode,
        defaultBookType: updated.defaultBookType,
        hedgedMarginPct: updated.hedgedMarginPct.toString(),
        stopLevel: updated.stopLevel,
        ...extraSnapshot(updated),
        ...(confirmBelowFloor ? { confirmedBelowHedgedFloor: true } : {}),
      },
    },
  });

  return NextResponse.json({
    symbolId: updated.symbolId,
    brokerSymbolId: updated.id,
    spreadMarkup: updated.spreadMarkup.toString(),
    minLot: updated.minLot.toString(),
    maxLot: updated.maxLot.toString(),
    lotStep: updated.lotStep.toString(),
    swapLong: updated.swapLong.toString(),
    swapShort: updated.swapShort.toString(),
    enabled: updated.enabled,
    commissionPerLot: updated.commissionPerLot.toString(),
    maxSlippagePoints: updated.maxSlippagePoints != null ? updated.maxSlippagePoints.toString() : null,
    maxExposure: updated.maxExposure?.toString() ?? null,
    tradingMode: updated.tradingMode,
    defaultBookType: updated.defaultBookType,
    hedgedMarginPct: updated.hedgedMarginPct.toString(),
    stopLevel: updated.stopLevel,
    ...extraSnapshot(updated),
  });
}

// the Symbols-tab settings of a row (all null when the row does not exist yet), as strings / numbers for audit and response
function extraSnapshot(bs: Parameters<typeof fieldsView>[0] | null) {
  const view = bs ? fieldsView(bs) : null;
  return Object.fromEntries(EXTRA_KEYS.map((k) => [k, view ? view[k] : null]));
}

// POST /api/manage/symbols
//   add:   { symbolName, ...settings, sessions? }   the Symbol must exist in the platform catalogue
//   clone: { fromBrokerSymbolId, symbolName }       copies every BrokerSymbol setting plus its sessions
// Both answer 201 with the new row: { brokerSymbolId, symbolId, symbolName, ...settings, sessions }. A new symbol is NOT
// enabled unless the request says so (and the caller may); a clone of an enabled symbol whose quote currency is not USD
// is created disabled (same rule as enabling it by hand).
async function postHandler(request: NextRequest) {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "send a JSON object" }, { status: 400 });
  const symbolName = typeof body.symbolName === "string" ? body.symbolName.trim() : "";
  if (!symbolName) return NextResponse.json({ error: "symbolName is required" }, { status: 400 });
  // adding or cloning a symbol writes its settings: GROUPS_SYMBOLS before anything is looked up (pricing / enabled are judged below)
  const early = await symbolWriteRefusal(session, ["tradingMode"], "manage/symbols POST");
  if (early) return early;

  const symbol = await prisma.symbol.findUnique({ where: { name: symbolName } });
  if (!symbol || (await symbolHiddenFromBroker(prisma, brokerId, symbol.name))) {
    return NextResponse.json({ error: `${symbolName} is not in the platform catalogue, so it cannot be added` }, { status: 400 });
  }
  const already = await prisma.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId, symbolId: symbol.id } } });
  if (already) return NextResponse.json({ error: `${symbol.name} is already added`, brokerSymbolId: already.id }, { status: 409 });

  const ctx = { brokerId, adminId: session.adminId, symbolName: symbol.name };
  const nonUsd = symbol.quoteCurrency !== "USD";

  if (typeof body.fromBrokerSymbolId === "string" && body.fromBrokerSymbolId !== "") {
    const source = await prisma.brokerSymbol.findUnique({ where: { id: body.fromBrokerSymbolId }, include: { symbol: { select: { name: true } } } });
    if (!source || source.brokerId !== brokerId) return NextResponse.json({ error: "the symbol to clone from was not found" }, { status: 404 });
    // the copied settings: everything except identity and timestamps
    const { id, brokerId: _b, symbolId: _s, createdAt: _c, updatedAt: _u, symbol: _sym, ...settings } = source;
    void id; void _b; void _s; void _c; void _u; void _sym;
    const copied = { ...settings, enabled: settings.enabled && !nonUsd };
    const touched = [
      ...(["spreadMarkup", "commissionPerLot", "swapLong", "swapShort"] as const).filter((k) => !source[k].isZero()),
      ...(copied.enabled ? ["enabled"] : []),
    ];
    // a clone writes every setting: GROUPS_SYMBOLS, plus PRICING / EMERGENCY_CONTROLS when it copies non-zero pricing or an enabled symbol
    const denied = await symbolWriteRefusal(session, ["tradingMode", ...touched], "manage/symbols POST");
    if (denied) return denied;
    const created = await prisma.$transaction(async (tx) => {
      const sessions = await readSessions(tx, source.id);
      const row = await createBrokerSymbol(tx, { ...ctx, source: "clone" }, symbol.id, copied, sessions, source.id);
      return { row, sessions };
    });
    return NextResponse.json({ brokerSymbolId: created.row.id, symbolId: symbol.id, symbolName: symbol.name, ...fieldsView(created.row), sessions: created.sessions }, { status: 201 });
  }

  const { data, errors } = parseSymbolFields(body, [...CORE_KEYS, ...EXTRA_KEYS]);
  if (errors.length > 0) return NextResponse.json({ error: errors.map((e) => `${e.field} ${e.reason}`).join("; "), fieldErrors: errors }, { status: 400 });
  let sessions: ReturnType<typeof validateSessions>["rows"] = [];
  if ("sessions" in body) {
    const v = validateSessions(body.sessions);
    if (v.rowErrors.length > 0) return NextResponse.json({ error: "some sessions are invalid", rowErrors: v.rowErrors }, { status: 400 });
    sessions = v.rows;
  }
  const cross = crossCheck(null, data);
  if (cross.length > 0) return NextResponse.json({ error: cross[0].reason, fieldErrors: cross }, { status: 400 });
  if (data.enabled === true && nonUsd) {
    return NextResponse.json({ error: `${symbol.name} cannot be enabled yet: P/L in ${displayCurrency(symbol.quoteCurrency)} is not supported.` }, { status: 400 });
  }
  // adding a symbol is a settings write (GROUPS_SYMBOLS) plus PRICING / EMERGENCY_CONTROLS for the pricing and enabled values sent
  const denied = await symbolWriteRefusal(session, ["tradingMode", ...Object.keys(data), ...(sessions.length > 0 ? ["sessions"] : [])], "manage/symbols POST");
  if (denied) return denied;
  const row = await prisma.$transaction((tx) => createBrokerSymbol(tx, { ...ctx, source: "add" }, symbol.id, { enabled: false, ...data }, sessions));
  return NextResponse.json({ brokerSymbolId: row.id, symbolId: symbol.id, symbolName: symbol.name, ...fieldsView(row), sessions }, { status: 201 });
}

// Batch 5 (real-time): a successful write announces the change to every open client (lib/config-events.ts)
export const PATCH = withConfigEvent("symbols", patchHandler);
export const POST = withConfigEvent("symbols", postHandler);
