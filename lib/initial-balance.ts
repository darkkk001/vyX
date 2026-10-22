// The account-creation funding: the ADJUSTMENT rows the account provisioning books (lib/account-provisioning.ts, a
// demo account in lib/demo.ts) and the approved starting-balance request of a new LIVE account
// (app/api/manage/accounts/route.ts). The writers use these exact notes and lib/account-summary.ts recognises the rows by
// them, so no client has to read the ledger's note text.
export const INITIAL_BALANCE_NOTE = "Initial balance on account creation";
export const LIVE_STARTING_BALANCE_NOTE = "Starting balance for a new LIVE account";

const NOTES = new Set([INITIAL_BALANCE_NOTE, LIVE_STARTING_BALANCE_NOTE]);

export function isInitialBalanceRow(r: { type: string; note?: string | null }): boolean {
  return r.type === "ADJUSTMENT" && r.note != null && NOTES.has(r.note);
}
