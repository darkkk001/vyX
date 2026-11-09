"use client";

import { currencySymbol } from "./money-input";

// The Deposit / Withdraw / Transfer amount: the selected account's currency symbol inside the field, before the number
// ($ for USD, € for EUR). Switching the account switches the symbol.
export default function AmountInput({ id, currency, value, onChange, disabled }: { id: string; currency: string | null | undefined; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const sym = currencySymbol(currency);
  return (
    <span className="r-amount">
      <span className="r-amount-sym mono" aria-hidden="true">{sym}</span>
      <input id={id} className="r-input mono" inputMode="decimal" placeholder="0.00" aria-label={`Amount in ${(currency || "USD").toUpperCase()}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ padding: "10px 12px", paddingLeft: 14 + sym.length * 8 }} />
    </span>
  );
}
