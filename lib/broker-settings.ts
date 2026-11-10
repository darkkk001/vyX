import { Prisma } from "@prisma/client";
import { MAX_PASSWORD_MAX_AGE_DAYS, MIN_PASSWORD_MAX_AGE_DAYS } from "@/lib/ip-allowlist";

// Step 3b item 2 (owner 2026-10-07): validation of the four new broker settings (PATCH /api/manage/settings).
export const MIN_AUDIT_RETENTION_DAYS = 365; // owner: never under a year
export const MIN_SESSION_TIMEOUT_MINUTES = 5;
export const MAX_SESSION_TIMEOUT_MINUTES = 60 * 24 * 30;
export const MAX_AUTO_APPROVE = new Prisma.Decimal("1000000000");

export type NewSettings = {
  sessionTimeoutMinutes?: number | null;
  auditRetentionDays?: number | null;
  autoApproveWithdrawalMax?: Prisma.Decimal | null;
  hedgingAllowed?: boolean;
  passwordMaxAgeDays?: number | null;
};
export type ParseResult = { ok: true; data: NewSettings } | { ok: false; error: string };

function wholeNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d{1,9}$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** Reads only the keys present in the body. null (or "" / 0 for the amount) switches a setting off. */
export function parseNewSettings(body: Record<string, unknown> | null): ParseResult {
  const data: NewSettings = {};
  if (!body) return { ok: true, data };
  if ("sessionTimeoutMinutes" in body) {
    const v = body.sessionTimeoutMinutes;
    if (v === null || v === "") data.sessionTimeoutMinutes = null;
    else {
      const n = wholeNumber(v);
      if (n === null || n < MIN_SESSION_TIMEOUT_MINUTES || n > MAX_SESSION_TIMEOUT_MINUTES) {
        return { ok: false, error: `session timeout must be ${MIN_SESSION_TIMEOUT_MINUTES} to ${MAX_SESSION_TIMEOUT_MINUTES} minutes, or off` };
      }
      data.sessionTimeoutMinutes = n;
    }
  }
  if ("auditRetentionDays" in body) {
    const v = body.auditRetentionDays;
    if (v === null || v === "") data.auditRetentionDays = null;
    else {
      const n = wholeNumber(v);
      if (n === null || n < MIN_AUDIT_RETENTION_DAYS) return { ok: false, error: `audit log must be kept at least ${MIN_AUDIT_RETENTION_DAYS} days` };
      data.auditRetentionDays = n;
    }
  }
  if ("autoApproveWithdrawalMax" in body) {
    const v = body.autoApproveWithdrawalMax;
    if (v === null || v === "" || v === 0 || v === "0") data.autoApproveWithdrawalMax = null;
    else {
      let d: Prisma.Decimal;
      try { d = new Prisma.Decimal(String(v)); } catch { return { ok: false, error: "auto-approve amount must be a number, or off" }; }
      if (!d.isFinite() || d.lte(0) || d.gt(MAX_AUTO_APPROVE) || d.decimalPlaces() > 2) {
        return { ok: false, error: "auto-approve amount must be more than 0, with at most 2 decimals" };
      }
      data.autoApproveWithdrawalMax = d;
    }
  }
  if ("passwordMaxAgeDays" in body) {
    const v = body.passwordMaxAgeDays;
    if (v === null || v === "") data.passwordMaxAgeDays = null;
    else {
      const n = wholeNumber(v);
      if (n === null || n < MIN_PASSWORD_MAX_AGE_DAYS || n > MAX_PASSWORD_MAX_AGE_DAYS) return { ok: false, error: `password change interval must be ${MIN_PASSWORD_MAX_AGE_DAYS} to ${MAX_PASSWORD_MAX_AGE_DAYS} days, or off` };
      data.passwordMaxAgeDays = n;
    }
  }
  if ("hedgingAllowed" in body) {
    if (typeof body.hedgingAllowed !== "boolean") return { ok: false, error: "hedgingAllowed must be true or false" };
    data.hedgingAllowed = body.hedgingAllowed;
  }
  return { ok: true, data };
}
