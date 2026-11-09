// Pure helpers of the Room money forms (no React), so tests and server code can use them.

/** The account currency's symbol for the amount field: $ for USD, € for EUR; the code itself when there is no symbol. */
export function currencySymbol(ccy: string | null | undefined): string {
  const code = (ccy || "USD").toUpperCase();
  try {
    const part = new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

/** One key per form load (Deposit / Withdraw / Transfer): the server answers a repeat with the first request. */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}
