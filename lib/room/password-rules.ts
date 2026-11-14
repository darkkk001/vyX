// The four rules of a trading or read-only password. The form shows them live; the server enforces the same list.
export type PasswordRule = { label: string; ok: boolean };

export function tradingPasswordRules(p: string): PasswordRule[] {
  return [
    { label: "8 to 15 characters", ok: p.length >= 8 && p.length <= 15 },
    { label: "Upper and lower case letters", ok: /[a-z]/.test(p) && /[A-Z]/.test(p) },
    { label: "At least one number", ok: /\d/.test(p) },
    { label: "At least one special character", ok: /[^A-Za-z0-9\s]/.test(p) },
  ];
}

export const tradingPasswordOk = (p: unknown): p is string => typeof p === "string" && tradingPasswordRules(p).every((r) => r.ok);

/** A client's label: trimmed, control characters out, at most 20 characters (owner 2026-11-14); empty means none. */
export function cleanNickname(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 20);
  return t || null;
}
