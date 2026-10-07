// Step 3b (owner 2026-10-07): every trading halt, close-only and sign-out-all clients is an INCIDENT and starts with a one-line
// reason, shown in the incident log. Required when the restriction is switched ON (and for sign-out-all); optional but kept when it
// is switched off. One line: runs of whitespace (including line breaks) collapse to single spaces; at most 200 characters.
export const INCIDENT_REASON_MAX = 200;

export type IncidentReason = { ok: true; reason: string | null } | { ok: false; error: string };

export function parseIncidentReason(raw: unknown, required: boolean): IncidentReason {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (text.length === 0) return required ? { ok: false, error: "Give a one-line reason." } : { ok: true, reason: null };
  if (text.length > INCIDENT_REASON_MAX) return { ok: false, error: `The reason is too long (at most ${INCIDENT_REASON_MAX} characters).` };
  return { ok: true, reason: text };
}
