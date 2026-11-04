// Symbols tab (backoffice 1.0.101): parsing, validation, serialisation and the write path for BrokerSymbol settings.
// One implementation behind PATCH /symbols/[id], bulk, add, clone and the CSV import, so every route validates and
// audits the same way. The app never derives or validates these values: it sends them, the server owns the rules.
import { Prisma, type BrokerSymbol, type TradingMode } from "@prisma/client";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { NextResponse } from "next/server";
import { writeRefusal } from "@/lib/group-permissions";
import type { AdminSessionPayload } from "@/lib/auth";

export type FieldError = { field: string; reason: string };

const TRADING_MODES = ["BOTH", "BUY_ONLY", "SELL_ONLY", "CLOSE_ONLY"] as const;
const EXECUTION_MODES = ["MARKET", "INSTANT"] as const;
const FILL_POLICIES = ["FOK", "IOC"] as const;
const SWAP_TYPES = ["POINTS", "PERCENT", "MONEY"] as const;

/** Every BrokerSymbol setting a symbols write may touch, in the order the CSV export lists them. */
export const CORE_KEYS = ["enabled", "spreadMarkup", "commissionPerLot", "swapLong", "swapShort", "minLot", "maxLot", "lotStep", "maxExposure", "stopLevel", "tradingMode"] as const;
export const EXTRA_KEYS = [
  "tickSize",
  "tickValue",
  "marginCurrency",
  "profitCurrency",
  "executionMode",
  "fillPolicy",
  "swapType",
  "tripleSwapDay",
  "freezeLevel",
  "marginInitial",
  "marginMaintenance",
  "description",
  "displayOrder",
] as const;
export const FIELD_KEYS = [...CORE_KEYS, ...EXTRA_KEYS] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** Settings that need the PRICING permission / the EMERGENCY_CONTROLS permission (same rule as PATCH /api/manage/symbols). */
export const PRICING_KEYS: FieldKey[] = ["spreadMarkup", "commissionPerLot", "swapLong", "swapShort"];
export const EMERGENCY_KEYS: FieldKey[] = ["enabled"];

function dec(v: unknown): Prisma.Decimal | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  try {
    const d = new Prisma.Decimal(typeof v === "string" ? v.trim() : v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}
function whole(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}
const blank = (v: unknown) => v === null || v === "" || v === undefined;

/**
 * Parses the settings present in `input` (only keys in `allowed` are looked at; an absent key is left alone).
 * Extra fields: null or "" clears them (no value = not set). Core fields keep the existing PATCH rules.
 * Returns Prisma-ready `data` for the valid keys and one error per invalid key.
 */
export function parseSymbolFields(input: Record<string, unknown>, allowed: readonly FieldKey[] = FIELD_KEYS): { data: Record<string, unknown>; errors: FieldError[] } {
  const data: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  const bad = (field: string, reason: string) => errors.push({ field, reason });
  for (const key of allowed) {
    if (!(key in input) || input[key] === undefined) continue;
    const v = input[key];
    switch (key) {
      case "enabled":
        if (typeof v === "boolean") data.enabled = v;
        else bad(key, "must be true or false");
        break;
      case "spreadMarkup":
      case "commissionPerLot": {
        const d = blank(v) ? new Prisma.Decimal(0) : dec(v);
        if (!d || d.lt(0)) bad(key, "must be a number, 0 or more");
        else data[key] = d;
        break;
      }
      case "swapLong":
      case "swapShort": {
        const d = blank(v) ? new Prisma.Decimal(0) : dec(v);
        if (!d) bad(key, "must be a number");
        else data[key] = d;
        break;
      }
      case "minLot":
      case "maxLot":
      case "lotStep": {
        const d = dec(v);
        if (!d || d.lte(0)) bad(key, "must be a number above 0");
        else data[key] = d;
        break;
      }
      case "maxExposure": {
        if (blank(v)) data.maxExposure = null;
        else {
          const d = dec(v);
          if (!d || d.lte(0)) bad(key, "must be a number above 0, or empty for no limit");
          else data.maxExposure = d;
        }
        break;
      }
      case "stopLevel": {
        const n = whole(v);
        if (n === null || n < 0 || n > 100000) bad(key, "must be a whole number of points from 0 to 100000");
        else data.stopLevel = n;
        break;
      }
      case "tradingMode":
        if (TRADING_MODES.includes(v as (typeof TRADING_MODES)[number])) data.tradingMode = v;
        else bad(key, `must be one of ${TRADING_MODES.join(", ")}`);
        break;
      case "tickSize":
      case "tickValue":
      case "marginInitial":
      case "marginMaintenance": {
        if (blank(v)) data[key] = null;
        else {
          const d = dec(v);
          // Decimal(18,10) / (18,6) / (10,4) columns: refuse what would not fit instead of letting the database error
          const max = key === "tickSize" ? new Prisma.Decimal("99999999.9999999999") : key === "tickValue" ? new Prisma.Decimal("999999999999.999999") : new Prisma.Decimal("999999.9999");
          const scale = key === "tickSize" ? 10 : key === "tickValue" ? 6 : 4;
          if (!d || d.lt(0) || d.gt(max) || d.decimalPlaces() > scale) bad(key, `must be a number, 0 or more, with at most ${scale} decimals`);
          else data[key] = d;
        }
        break;
      }
      case "marginCurrency":
      case "profitCurrency": {
        if (blank(v)) data[key] = null;
        else if (typeof v === "string" && /^[A-Za-z]{3}$/.test(v.trim())) data[key] = v.trim().toUpperCase();
        else bad(key, "must be a 3-letter currency code");
        break;
      }
      case "executionMode":
      case "fillPolicy":
      case "swapType": {
        const list = key === "executionMode" ? EXECUTION_MODES : key === "fillPolicy" ? FILL_POLICIES : SWAP_TYPES;
        if (blank(v)) data[key] = null;
        else if (list.includes(v as never)) data[key] = v;
        else bad(key, `must be one of ${list.join(", ")}`);
        break;
      }
      case "tripleSwapDay": {
        if (blank(v)) data.tripleSwapDay = null;
        else {
          const n = whole(v);
          if (n === null || n < 0 || n > 6) bad(key, "must be a whole number from 0 (Sunday) to 6");
          else data.tripleSwapDay = n;
        }
        break;
      }
      case "freezeLevel":
      case "displayOrder": {
        if (blank(v)) data[key] = null;
        else {
          const n = whole(v);
          if (n === null || n < 0 || n > 2_000_000_000) bad(key, "must be a whole number, 0 or more");
          else data[key] = n;
        }
        break;
      }
      case "description": {
        if (blank(v)) data.description = null;
        else if (typeof v === "string" && v.trim().length <= 500) data.description = v.trim();
        else bad(key, "must be text of at most 500 characters");
        break;
      }
    }
  }
  return { data, errors };
}

/** minLot <= maxLot on the values the row will have after the write. */
export function crossCheck(current: Pick<BrokerSymbol, "minLot" | "maxLot"> | null, data: Record<string, unknown>): FieldError[] {
  const minLot = (data.minLot as Prisma.Decimal | undefined) ?? current?.minLot ?? new Prisma.Decimal("0.01");
  const maxLot = (data.maxLot as Prisma.Decimal | undefined) ?? current?.maxLot ?? new Prisma.Decimal(100);
  return minLot.gt(maxLot) ? [{ field: data.maxLot !== undefined ? "maxLot" : "minLot", reason: "minLot must not be greater than maxLot" }] : [];
}

/** The settings of a BrokerSymbol as the routes return them: decimals as strings, no value = null. */
export function fieldsView(bs: BrokerSymbol) {
  const s = (d: Prisma.Decimal | null) => (d === null ? null : d.toString());
  return {
    enabled: bs.enabled,
    spreadMarkup: bs.spreadMarkup.toString(),
    commissionPerLot: bs.commissionPerLot.toString(),
    swapLong: bs.swapLong.toString(),
    swapShort: bs.swapShort.toString(),
    minLot: bs.minLot.toString(),
    maxLot: bs.maxLot.toString(),
    lotStep: bs.lotStep.toString(),
    maxExposure: s(bs.maxExposure),
    stopLevel: bs.stopLevel,
    tradingMode: bs.tradingMode as TradingMode,
    tickSize: s(bs.tickSize),
    tickValue: s(bs.tickValue),
    marginCurrency: bs.marginCurrency,
    profitCurrency: bs.profitCurrency,
    executionMode: bs.executionMode,
    fillPolicy: bs.fillPolicy,
    swapType: bs.swapType,
    tripleSwapDay: bs.tripleSwapDay,
    freezeLevel: bs.freezeLevel,
    marginInitial: s(bs.marginInitial),
    marginMaintenance: s(bs.marginMaintenance),
    description: bs.description,
    displayOrder: bs.displayOrder,
  };
}
export type FieldsView = ReturnType<typeof fieldsView>;

/** The keys whose stored value differs between two views. */
export function changedKeys(before: FieldsView | null, after: FieldsView): FieldKey[] {
  return FIELD_KEYS.filter((k) => !before || before[k] !== after[k]);
}

/** Equal for the changed-fields compare: numbers, Decimals and strings by their text, null / undefined alike. */
function sameText(a: unknown, b: unknown): boolean {
  const t = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return t(a) === t(b);
}

/** The keys of `data` whose value differs from the stored view (all of them when there is no stored row). */
export function changedAgainst(view: FieldsView | null, data: Record<string, unknown>): string[] {
  return Object.keys(data).filter((k) => !view || !sameText(view[k as FieldKey], data[k]));
}

/**
 * The write rule for every symbols-tab write (2026-11-04, same as lib/group-permissions.ts and PATCH /api/manage/symbols),
 * judged on the keys a request CHANGES: pricing keys need PRICING, `enabled` needs EMERGENCY_CONTROLS, every other setting
 * and the trading hours ("sessions") need GROUPS_SYMBOLS. BROKER_ADMIN holds all. null = allowed, otherwise the 403 to return
 * ({ error, permission, permissionLabel }, the shape those routes already use).
 */
export async function symbolWriteRefusal(session: AdminSessionPayload | null, keys: readonly string[], routeName: string): Promise<NextResponse | null> {
  if (keys.some((k) => (PRICING_KEYS as string[]).includes(k)) && (await forbidUnlessBrokerAdminOrPermission(session, "PRICING"))) {
    return NextResponse.json({ error: "forbidden", permission: "PRICING", permissionLabel: PERMISSION_LABELS.PRICING }, { status: 403 });
  }
  if (keys.some((k) => (EMERGENCY_KEYS as string[]).includes(k)) && (await forbidUnlessBrokerAdminOrPermission(session, "EMERGENCY_CONTROLS"))) {
    return NextResponse.json({ error: "forbidden", permission: "EMERGENCY_CONTROLS", permissionLabel: PERMISSION_LABELS.EMERGENCY_CONTROLS }, { status: 403 });
  }
  if (keys.some((k) => !(PRICING_KEYS as string[]).includes(k) && !(EMERGENCY_KEYS as string[]).includes(k))) {
    return writeRefusal(session, ["config"], routeName);
  }
  return null;
}
