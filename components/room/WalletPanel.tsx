"use client";

import { useCallback, useEffect, useState } from "react";
import { useRoomEvent } from "./RoomData";
import { money } from "./format";

// The Funding wallet tab. The balance is the server's; a first Deposit, Withdraw or Transfer creates the wallet, then the
// usual funds screens carry on with it.
type Wallet = { id: string | null; accountNumber: string | null; balance: string; currency: string };
const STEPS = [
  { title: "Store funds", text: "Deposit once and keep the money here, ready to use." },
  { title: "Transfer to an account", text: "Move what you need to any real account, instantly." },
  { title: "Move profits back", text: "Bring profits back here, then withdraw when you choose." },
];

export default function WalletPanel() {
  const [w, setW] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const res = await fetch("/api/room/wallet", { cache: "no-store" });
    if (res.ok) setW(await res.json());
    else setError("Could not load the wallet.");
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });

  async function go(to: (id: string) => string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/room/wallet", { method: "POST" });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setBusy(false); setError(body?.error ?? "Could not open the wallet."); return; }
    window.location.assign(to(body.id));
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
      <div className="r-card" style={{ flex: "2 1 340px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div className="r-label">Funding wallet</div>
          <div className="mono" style={{ fontSize: 30, fontWeight: 600, marginTop: 10 }}>{w ? money(w.balance) : "0.00"} <span style={{ fontSize: 14, color: "var(--r-muted)", fontWeight: 400 }}>{w?.currency ?? ""}</span></div>
          {w?.accountNumber ? <div className="mono" style={{ fontSize: 12, color: "var(--r-muted)", marginTop: 6 }}>{w.accountNumber}</div> : null}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="r-btn" disabled={busy} onClick={() => go((id) => `/room/deposit?account=${id}`)}>Deposit</button>
          <button type="button" className="r-btn-ghost" disabled={busy} onClick={() => go((id) => `/room/withdraw?account=${id}`)}>Withdraw</button>
          <button type="button" className="r-btn-ghost" disabled={busy} onClick={() => go((id) => `/room/transfer?from=${id}`)}>Transfer</button>
        </div>
        {error ? <div className="r-error" role="status">{error}</div> : null}
      </div>
      <div className="r-card" style={{ flex: "1 1 280px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: "var(--r-head)", fontSize: 16, fontWeight: 600 }}>How it works</div>
        {STEPS.map((s, i) => (
          <div key={s.title} style={{ display: "flex", gap: 12 }}>
            <span className="mono" style={{ color: "var(--r-accent)", fontSize: 13, fontWeight: 600 }}>{i + 1}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</div>
              <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 3, lineHeight: 1.5 }}>{s.text}</div>
            </div>
          </div>
        ))}
        <div className="r-note">Your funds stay with your broker. The wallet does not trade.</div>
      </div>
    </div>
  );
}
