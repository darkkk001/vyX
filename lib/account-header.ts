// The account header, the same in every app (terminal, mobile, WebTrader): plan name, client
// name, account number, one per line; nothing else (components/webtrader/AccountHeader.tsx).
// Account pickers read "Plan · Name · Number". The plan is the client-facing accountPlan; the
// backend group is never shown. A part the server did not send is left out (no placeholder).

/** accountPlan as a name, or an object with a name; "" otherwise. */
export function planOf(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string") return ((v as { name: string }).name).trim();
  return "";
}

export function accountPickerLabel(plan: unknown, name: string | null | undefined, number: string | null | undefined): string {
  return [planOf(plan), (name ?? "").trim(), (number ?? "").trim()].filter((s) => s.length > 0).join(" · ");
}

export type AccountHeaderLine = { kind: "plan" | "name" | "number"; text: string };

/** The header's lines in order: plan, client name, account number; a part not sent is left out. */
export function accountHeaderLines(plan: unknown, name: string | null | undefined, number: string | null | undefined): AccountHeaderLine[] {
  const all: AccountHeaderLine[] = [{ kind: "plan", text: planOf(plan) }, { kind: "name", text: (name ?? "").trim() }, { kind: "number", text: (number ?? "").trim() }];
  return all.filter((l) => l.text.length > 0);
}
