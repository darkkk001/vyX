"use client";

import type { ReactNode } from "react";

// After a Deposit / Withdraw / Transfer went through, this card replaces the form, so the same request cannot be sent
// again. "New ..." starts a fresh form (a new request key).
export default function FundsDone({ title, children, again, onAgain }: { title: string; children: ReactNode; again: string; onAgain: () => void }) {
  return (
    <div className="r-card r-funds-done" role="status">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="16" fill="none" stroke="var(--r-ok)" strokeWidth="1.6" /><path d="m10.5 17.5 4.5 4.5 8.5-9" fill="none" stroke="var(--r-ok)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--r-text-2)", lineHeight: 1.7 }}>{children}</div>
      <button type="button" className="r-btn-ghost" style={{ padding: "10px 20px" }} onClick={onAgain}>{again}</button>
    </div>
  );
}
