import "server-only";
import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { LEVERAGE_RULE, parseLeverage } from "@/lib/leverage";

// Shared by the backoffice HMR plugin routes (app/api/manage/plugins/hmr/**): BROKER_ADMIN only, and the field parsers.
export async function requireHmrAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return null;
  return session!;
}

export const forbidden = () => NextResponse.json({ error: "forbidden" }, { status: 403 });

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** An instant with an explicit zone ("2026-11-06T13:30:00Z"); the UI converts broker time to UTC before sending. */
export function parseInstant(raw: unknown): Date | null {
  if (typeof raw !== "string" || !ISO_WITH_ZONE.test(raw.trim())) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseCurrency(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Z]{3}$/.test(raw.trim().toUpperCase()) ? raw.trim().toUpperCase() : null;
}

export type WindowInput = { currency: string; startsAt: Date; endsAt: Date; leverage: number; enabled: boolean };

export function parseWindowFields(body: Record<string, unknown>, existing?: WindowInput): { ok: true; value: WindowInput } | { ok: false; error: string } {
  const currency = "currency" in body || !existing ? parseCurrency(body.currency) : existing.currency;
  if (!currency) return { ok: false, error: "currency must be a 3-letter code such as USD" };
  const startsAt = "startsAt" in body || !existing ? parseInstant(body.startsAt) : existing.startsAt;
  if (!startsAt) return { ok: false, error: "startsAt must be a UTC time such as 2026-11-06T13:30:00Z" };
  const endsAt = "endsAt" in body || !existing ? parseInstant(body.endsAt) : existing.endsAt;
  if (!endsAt) return { ok: false, error: "endsAt must be a UTC time such as 2026-11-06T14:30:00Z" };
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "the window must end after it starts" };
  const leverage = "leverage" in body || !existing ? parseLeverage(body.leverage) : existing.leverage;
  if (leverage == null) return { ok: false, error: `leverage must be ${LEVERAGE_RULE}` };
  if ("enabled" in body && typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
  const enabled = typeof body.enabled === "boolean" ? body.enabled : existing?.enabled ?? true;
  return { ok: true, value: { currency, startsAt, endsAt, leverage, enabled } };
}

export const windowDto = (w: { id: string; currency: string; startsAt: Date; endsAt: Date; leverage: number; enabled: boolean; createdBy: string | null }) => ({
  id: w.id,
  currency: w.currency,
  startsAt: w.startsAt.toISOString(),
  endsAt: w.endsAt.toISOString(),
  leverage: w.leverage,
  enabled: w.enabled,
  createdBy: w.createdBy,
});
