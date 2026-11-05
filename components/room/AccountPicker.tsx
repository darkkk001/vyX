"use client";

import { useRoom } from "./RoomData";

// The account the room is showing. In the top bar on a desktop, in the avatar menu on a phone.
export default function AccountPicker() {
  const { data, selected, select } = useRoom();
  if (!data || data.accounts.length === 0) return null;
  return (
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
  );
}
