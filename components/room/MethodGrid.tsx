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
// locked (owner 2026-11-12): the client's identity is not verified yet, so every card is shown but none can be picked;
// each says why ("Verify your identity to deposit") with a "Verify now" link. A card is then not a button (a link
// inside a button is not valid), only a panel.
export default function MethodGrid({ methods, selectedId, currency, side = "deposit", onSelect, waits, now, locked = false }: { methods: FundsMethod[]; selectedId: string | null; currency: string; side?: "deposit" | "withdraw"; onSelect: (id: string) => void; waits?: Record<string, string>; now?: number; locked?: boolean }) {
  return (
    <div className="r-method-grid">
      {methods.map((m) => {
        const sel = m.available && m.id === selectedId;
        const terms = side === "withdraw" ? m.withdraw : m;
        const lines: [string, string | null][] = [["Processing", terms.processing], ["Fee", m.feeLine ?? "0%"], ["Limits", limits(terms, currency)]];
        if (locked) {
          return (
            <div key={m.id} className="r-method is-locked">
              <span className="r-method-name">{m.label}</span>
              {lines.map(([k, v]) => (v ? <span key={k} className="r-method-line"><span>{k}</span><span className="mono" title={v}>{v}</span></span> : <span key={k} className="r-method-line" aria-hidden="true" />))}
              <span className="r-method-lock">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2.5" y="5.5" width="7" height="5" rx="1" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" /></svg>
                Verify your identity to {side}
              </span>
              <a className="r-method-verify" href="/room/verify">Verify now</a>
            </div>
          );
        }
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
