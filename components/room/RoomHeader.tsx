"use client";

import type { ReactNode } from "react";
import { useRoom } from "./RoomData";
import { money } from "./format";

// The page header on every Trader's Room screen: title, the account picker, its balance. `right` replaces the picker
// on screens whose artboard shows something else there (Support's "New ticket", Profile's "Sign out").
export default function RoomHeader({ title, right, picker = true }: { title: string; right?: ReactNode; picker?: boolean }) {
  const { data, selected, select } = useRoom();
  return (
    <header className="r-head">
      <h1>{title}</h1>
      <div className="r-head-right">
        {right}
        {picker && data && data.accounts.length > 0 ? (
          <>
            <label className="r-acct-select" style={{ position: "relative", paddingRight: 28 }}>
              <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Account</span>
              <select
                value={selected?.id ?? ""}
                onChange={(e) => select(e.target.value)}
                style={{ appearance: "none", background: "transparent", border: "none", color: "inherit", font: "inherit", cursor: "pointer", paddingRight: 4 }}
              >
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id} style={{ background: "var(--r-card)" }}>{`${a.accountNumber} · ${a.mode === "DEMO" ? "Demo" : a.plan}`}</option>
                ))}
              </select>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--r-muted)" strokeWidth="1.5" aria-hidden="true" style={{ position: "absolute", right: 12, pointerEvents: "none" }}><path d="M2 3.5 5 6.5 8 3.5" /></svg>
            </label>
            {selected ? (
              <span className="r-head-bal">{money(selected.figures.balance)} <span style={{ color: "var(--r-muted)", fontWeight: 400 }}>{selected.currency}</span></span>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
