"use client";

import type { FundsMethod } from "./useFunds";

// The broker's payment methods as a grid (Deposit and Withdraw). A method the broker lists but has not switched on is
// shown greyed and cannot be picked. Lines a broker has not configured are left out.
const limits = (t: { min: string; max: string | null }, ccy: string) => {
  const min = Number(t.min) > 0 ? Number(t.min).toLocaleString("en-US") : null;
  const max = t.max ? Number(t.max).toLocaleString("en-US") : null;
  if (min && max) return `${min} to ${max} ${ccy}`;
  if (min) return `From ${min} ${ccy}`;
  return max ? `Up to ${max} ${ccy}` : null;
};

export default function MethodGrid({ methods, selectedId, currency, side = "deposit", onSelect }: { methods: FundsMethod[]; selectedId: string | null; currency: string; side?: "deposit" | "withdraw"; onSelect: (id: string) => void }) {
  return (
    <div className="r-method-grid">
      {methods.map((m) => {
        const sel = m.available && m.id === selectedId;
        const terms = side === "withdraw" ? m.withdraw : m;
        const lines: [string, string | null][] = [["Processing", terms.processing], ["Fee", m.feeLine ?? "0%"], ["Limits", limits(terms, currency)]];
        return (
          <button key={m.id} type="button" className={`r-method${sel ? " is-selected" : ""}`} disabled={!m.available} aria-pressed={sel} onClick={() => onSelect(m.id)}>
            <span className="r-method-name">{m.label}</span>
            {lines.filter(([, v]) => v).map(([k, v]) => <span key={k} className="r-method-line"><span>{k}</span><span className="mono">{v}</span></span>)}
            {m.available ? null : <span className="r-method-chip">Not available in your country</span>}
          </button>
        );
      })}
    </div>
  );
}
