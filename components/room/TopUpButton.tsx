"use client";

import { useEffect, useRef, useState } from "react";
import AmountInput from "./AmountInput";
import { amountOk, cleanAmount, useSendOnce } from "./useFunds";
import { money } from "./format";
import { useRoom, type RoomAccount } from "./RoomData";

// Demo accounts' "Top up" (owner 2026-11-10): the balance goes up at once, no approval, never above 100,000 in the account
// currency. The server refuses a live account whatever this sends (app/api/room/accounts/[id]/top-up).
const CAP = 100_000;

export default function TopUpButton({ account, onDone, className = "r-btn r-btn-sm", style }: { account: RoomAccount; onDone?: () => void; className?: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  if (account.mode !== "DEMO") return null;
  return (
    <>
      <button type="button" className={className} style={style} onClick={() => setOpen(true)}>Top up</button>
      {open ? <TopUpDialog account={account} onClose={() => setOpen(false)} onDone={onDone} /> : null}
    </>
  );
}

function TopUpDialog({ account, onClose, onDone }: { account: RoomAccount; onClose: () => void; onDone?: () => void }) {
  const { refresh } = useRoom();
  const room = Math.max(0, CAP - Number(account.figures.balance));
  const [amount, setAmount] = useState(room >= 10_000 ? "10000" : room > 0 ? room.toFixed(2) : "");
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState<{ amount: string; balance: string } | null>(null);
  const send = useSendOnce();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  async function submit() {
    if (!amountOk(amount)) { setMsg("Enter an amount."); return; }
    if (!send.begin()) return;
    setMsg("");
    let res: Response | null = null;
    let body: { error?: string; amount?: string; balance?: string } | null = null;
    try {
      res = await fetch(`/api/room/accounts/${encodeURIComponent(account.id)}/top-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: send.key, amount: cleanAmount(amount) }) });
      body = await res.json().catch(() => null);
    } catch { /* no connection: the message below */ }
    send.end();
    if (!res || !res.ok || !body?.balance) { setMsg(body?.error ?? "Could not top up. Try again."); return; }
    setDone({ amount: body.amount ?? cleanAmount(amount), balance: body.balance });
    void refresh();
    onDone?.();
  }

  const label = { fontSize: 10.5, letterSpacing: 1.2 } as const;
  return (
    <div className="r-modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="r-modal" role="dialog" aria-modal="true" aria-label="Top up demo account" style={{ maxWidth: 380 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>Top up demo account</div>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 4 }}>{account.accountNumber} · {money(done?.balance ?? account.figures.balance)} {account.currency}</div>
          </div>
          <button ref={close} type="button" className="r-icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        {done ? (
          <div className="r-okmsg" role="status">{money(done.amount)} {account.currency} added. Balance {money(done.balance)} {account.currency}.</div>
        ) : room <= 0 ? (
          <div className="r-note">This demo account already holds the most it can ({money(CAP)} {account.currency}).</div>
        ) : (
          <>
            <div className="r-field">
              <label htmlFor="topup-amt" style={label}>Amount</label>
              <AmountInput id="topup-amt" currency={account.currency} value={amount} disabled={send.busy} onChange={(v) => { setAmount(v); if (msg) setMsg(""); }} />
              <div style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Up to <span className="mono" style={{ fontSize: "inherit" }}>{money(room)} {account.currency}</span>. Demo balances stay at or under {money(CAP)}.</div>
            </div>
            {msg ? <div className="r-error" role="status">{msg}</div> : null}
            <button type="button" className="r-btn" style={{ padding: "11px 24px", alignSelf: "flex-start" }} disabled={send.busy} onClick={submit}>{send.busy ? "Adding…" : "Top up"}</button>
          </>
        )}
      </div>
    </div>
  );
}
