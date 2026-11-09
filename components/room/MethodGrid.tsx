"use client";

import type { FundsMethod } from "./useFunds";
import { countdown } from "./money-input";

// The broker's payment methods as a grid (Deposit and Withdraw). A method the broker lists but has not switched on is
// shown greyed and cannot be picked. Every card is the same height with its rows in fixed slots (an unset value leaves
// its slot empty) and the "Not available" badge pinned at the bottom (room.css .r-method-grid / .r-method-chip).
const limits = (t: { min: string; max: string | null }, ccy: string) => {
  const min = Number(t.min) > 0 ? Number(t.min).toLocaleString("en-US") : null;
  const max = t.max ? Number(t.max).toLocaleString("en-US") : null;
  if (min && max) return `${min} to ${max} ${ccy}`;
  if (min) return `From ${min} ${ccy}`;
  return max ? `Up to ${max} ${ccy}` : null;
};

// waits (Deposit, owner 2026-11-10): method id -> until when this client sends no other deposit with it; the card shows
// "Next request in 4:32" at the badge spot. now = the page's clock, corrected to the server's.
export default function MethodGrid({ methods, selectedId, currency, side = "deposit", onSelect, waits, now }: { methods: FundsMethod[]; selectedId: string | null; currency: string; side?: "deposit" | "withdraw"; onSelect: (id: string) => void; waits?: Record<string, string>; now?: number }) {
  return (
    <div className="r-method-grid">
      {methods.map((m) => {
        const sel = m.available && m.id === selectedId;
        const terms = side === "withdraw" ? m.withdraw : m;
        const lines: [string, string | null][] = [["Processing", terms.processing], ["Fee", m.feeLine ?? "0%"], ["Limits", limits(terms, currency)]];
        return (
          <button key={m.id} type="button" className={`r-method${sel ? " is-selected" : ""}`} disabled={!m.available} aria-pressed={sel} onClick={() => onSelect(m.id)}>
            <span className="r-method-name">{m.label}</span>
            {/* fixed slots in a fixed order (Processing, Fee, Limits): a value the broker has not set leaves its slot empty, so rows line up across cards */}
            {lines.map(([k, v]) => (v ? <span key={k} className="r-method-line"><span>{k}</span><span className="mono" title={v}>{v}</span></span> : <span key={k} className="r-method-line" aria-hidden="true" />))}
            {m.available ? null : <span className="r-method-chip">Not available</span>}
            {m.available && waits?.[m.id] && new Date(waits[m.id]).getTime() > (now ?? Date.now()) ? <span className="r-method-chip r-method-wait">Next request in {countdown(waits[m.id], now)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
