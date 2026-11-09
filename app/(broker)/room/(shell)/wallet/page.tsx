"use client";

import { useCallback, useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money } from "@/components/room/format";
import { currencySymbol } from "@/components/room/money-input";
import { readStore, storeKey, writeStore } from "@/components/room/money-menu";

// Funding wallet (owner 2026-11-10): real money kept apart from trading. Every client sees it, also before the wallet
// exists (0.00; a read never creates it). Deposit, Withdraw and Transfer create it on first use (POST /api/room/wallet),
// then open the usual funds screens with the wallet picked. The info card can be closed; that is remembered per client.
type Wallet = { id: string | null; accountNumber: string | null; balance: string; currency: string };
const STEPS = [
  { title: "Store your funds", text: "Deposit into the wallet and keep your funds there until you trade." },
  { title: "Make instant transfers", text: "Move the amount you want to a trading account in seconds." },
  { title: "Manage your profits", text: "Move profits back to the wallet anytime." },
];
const INFO = ["Funds stay out of trading risk", "No fees for storing funds", "Move money to any account in seconds"];

const currencyName = (code: string) => {
  try { return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code; } catch { return code; }
};
const Tick = () => <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--r-ok)" strokeWidth="1.8" aria-hidden="true" style={{ flexShrink: 0 }}><path d="m2.5 7.5 3 3 6-6" /></svg>;

export default function RoomWallet() {
  const { data } = useRoom();
  const clientId = data?.client.clientId ?? "";
  const [w, setW] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(false);
  useEffect(() => { if (clientId) setInfo(readStore(storeKey("walletInfo", clientId)) !== "closed"); }, [clientId]);
  const load = useCallback(async () => {
    const res = await fetch("/api/room/wallet", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setW(await res.json());
    else setError("Could not load the wallet.");
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });

  async function go(to: (id: string) => string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/room/wallet", { method: "POST" }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (!res?.ok || !body?.id) { setBusy(false); setError(body?.error ?? "Could not open the wallet."); return; }
    window.location.assign(to(body.id));
  }
  function closeInfo() {
    setInfo(false);
    writeStore(storeKey("walletInfo", clientId), "closed");
  }

  const ccy = w?.currency ?? "USD";
  return (
    <>
      <RoomHeader title="Funding wallet" />
      <div className="r-body" style={{ gap: 20 }}>
        {info ? (
          <div className="r-card r-wallet-info" role="note">
            <span className="r-wallet-info-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="var(--r-accent)" strokeWidth="1.2"><path d="M2.5 4.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7Z" /><path d="M2.5 4.5 10.5 2.5v2" /><path d="M11 8.5h2.5" /></svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--r-head)", fontSize: 17, fontWeight: 600 }}>Keep funds separate. Transfer anytime.</div>
              <div className="r-wallet-info-lines">
                {INFO.map((t) => <div key={t} style={{ display: "flex", alignItems: "center", gap: 8 }}><Tick />{t}</div>)}
              </div>
            </div>
            <button type="button" className="r-icon-btn" aria-label="Close" onClick={closeInfo} style={{ alignSelf: "flex-start" }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
            </button>
          </div>
        ) : null}

        <div className="r-card r-wallet-card">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="r-ccy-badge" aria-hidden="true">{currencySymbol(ccy)}</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{currencyName(ccy)}</div>
              <div className="mono" style={{ fontSize: 11, color: "var(--r-muted)", marginTop: 2 }}>{w?.accountNumber ? `Wallet ${w.accountNumber}` : "Wallet number given on first use"}</div>
            </div>
          </div>
          <div className="mono r-wallet-balance">{w ? money(w.balance) : "0.00"} <span>{ccy}</span></div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="r-btn" disabled={busy || !w} onClick={() => go((id) => `/room/deposit?account=${id}`)}>Deposit</button>
            <button type="button" className="r-btn-ghost" disabled={busy || !w} onClick={() => go((id) => `/room/withdraw?account=${id}`)}>Withdraw</button>
            <button type="button" className="r-btn-ghost" disabled={busy || !w} onClick={() => go((id) => `/room/transfer?from=${id}`)}>Transfer</button>
          </div>
          {error ? <div className="r-error" role="status">{error}</div> : null}
        </div>

        <div>
          <div className="r-label" style={{ padding: "2px 2px 10px" }}>How it works</div>
          <div className="r-wallet-steps">
            {STEPS.map((s, i) => (
              <div key={s.title} className="r-card r-pad" style={{ display: "flex", gap: 14 }}>
                <span className="r-step-num mono">{i + 1}</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 4, lineHeight: 1.6 }}>{s.text}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
