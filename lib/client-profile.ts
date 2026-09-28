// Client portal profile edits (PATCH /api/portal/me). Owner decision 2026-09-28:
//   * phone is always editable;
//   * full name, country and date of birth are the client's KYC identity: editable only until KYC is submitted.
//     While the client KYC record is PENDING or APPROVED they are locked and a change goes through support.
//     A REJECTED record unlocks them again (the client has to correct them before resubmitting);
//   * email is never editable here: it is the login identity, tied to emailVerifiedAt (a separate feature);
//   * every applied change is audited (the route writes CLIENT_PROFILE_UPDATED with the old and new values).
// Pure: the route loads the client and its KYC status, this decides what may change.

export type KycState = "PENDING" | "APPROVED" | "REJECTED" | null;

export type ProfileFields = {
  fullName: string;
  phone: string | null;
  country: string | null;
  dateOfBirth: Date | null;
};

export type ProfileChange = { field: keyof ProfileFields; from: string | null; to: string | null };

export type ProfileUpdateResult =
  | { ok: true; data: Partial<ProfileFields>; changes: ProfileChange[] }
  | { ok: false; status: 400 | 409; error: string };

export const IDENTITY_FIELDS = ["fullName", "country", "dateOfBirth"] as const;

export const IDENTITY_LOCKED_MESSAGE =
  "Your name, country and date of birth are locked while your KYC is under review or approved. Contact support to change them.";

export function identityLocked(kyc: KycState): boolean {
  return kyc === "PENDING" || kyc === "APPROVED";
}

const PHONE_RE = /^\+?[0-9 ()./-]{4,32}$/;

// a DATE column: compare and show as YYYY-MM-DD, never through the local time zone (a UTC midnight shown with
// toLocaleDateString reads as the previous day west of UTC)
export function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function display(field: keyof ProfileFields, v: ProfileFields[keyof ProfileFields]): string | null {
  if (v === null || v === undefined) return null;
  return field === "dateOfBirth" ? dateOnly(v as Date) : String(v);
}

export function resolveProfileUpdate(body: unknown, current: ProfileFields, kyc: KycState, now: Date = new Date()): ProfileUpdateResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "invalid request body" };
  const b = body as Record<string, unknown>;
  const wanted: Partial<ProfileFields> = {};

  if ("fullName" in b) {
    const v = typeof b.fullName === "string" ? b.fullName.trim().replace(/\s+/g, " ") : "";
    if (!v) return { ok: false, status: 400, error: "full name is required" };
    if (v.length > 100) return { ok: false, status: 400, error: "full name must be at most 100 characters" };
    wanted.fullName = v;
  }
  if ("phone" in b) {
    const v = typeof b.phone === "string" ? b.phone.trim() : "";
    if (v && !PHONE_RE.test(v)) return { ok: false, status: 400, error: "phone may contain digits, spaces, + ( ) - . / and must be 4 to 32 characters" };
    wanted.phone = v || null;
  }
  if ("country" in b) {
    const v = typeof b.country === "string" ? b.country.trim() : "";
    if (v.length > 64) return { ok: false, status: 400, error: "country must be at most 64 characters" };
    wanted.country = v || null;
  }
  if ("dateOfBirth" in b) {
    const raw = typeof b.dateOfBirth === "string" ? b.dateOfBirth.trim() : "";
    if (!raw) {
      wanted.dateOfBirth = null;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, status: 400, error: "date of birth must be YYYY-MM-DD" };
      const d = new Date(`${raw}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || dateOnly(d) !== raw) return { ok: false, status: 400, error: "date of birth is not a real date" };
      if (d > now || d.getUTCFullYear() < 1900) return { ok: false, status: 400, error: "date of birth must be a valid date in the past" };
      wanted.dateOfBirth = d;
    }
  }

  // only real differences count: the form sends every field back, so a locked field sent unchanged is fine
  const changes: ProfileChange[] = [];
  const data: Partial<ProfileFields> = {};
  for (const field of Object.keys(wanted) as (keyof ProfileFields)[]) {
    const from = display(field, current[field]);
    const to = display(field, wanted[field] as ProfileFields[keyof ProfileFields]);
    if (from === to) continue;
    if (identityLocked(kyc) && (IDENTITY_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, status: 409, error: IDENTITY_LOCKED_MESSAGE };
    }
    changes.push({ field, from, to });
    (data as Record<string, unknown>)[field] = wanted[field];
  }
  if (Object.keys(wanted).length === 0) return { ok: false, status: 400, error: "no fields to update" };
  return { ok: true, data, changes };
}
