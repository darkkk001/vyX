"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRoom, useRoomEvent } from "./RoomData";
import { money } from "./format";
import { moneyRows, pickedRow, readStore, shown, storeKey, writeStore, type RoomMoney } from "./money-menu";

// The top bar's wallet button (owner 2026-11-10): by default the client's overall real money (funding wallet + every live
// trading account, in USD; demo never counts). The menu: Deposit / Withdraw / Transfer, "Hide balance", then Overall, each
// live trading account, the Funding wallet and (an IB) the Partner wallet. Picking a row puts its balance in the top bar;
// the pick and Hide balance are remembered per client in this browser. Figures are the server's (GET /api/room/money),
// re-read on every room event (the dashboard's realtime path) and every 30 s.
const WalletIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M2.5 4.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7Z" /><path d="M2.5 4.5 10.5 2.5v2" /><path d="M11 8.5h2.5" />
  </svg>
);
const ACTIONS = [
  { href: "/room/deposit", label: "Deposit", d: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" },
  { href: "/room/withdraw", label: "Withdraw", d: "M8 13.5v-8M4.5 9 8 5.5 11.5 9M3 2.5h10" },
  { href: "/room/transfer", label: "Transfer", d: "M3 5.5h9M9.5 3 12 5.5 9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13" },
];

export default function WalletMenu({ compact = false }: { compact?: boolean }) {
  const { data } = useRoom();
  const clientId = data?.client.clientId ?? "";
  const [m, setM] = useState<RoomMoney | null>(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clientId) return;
    setHidden(readStore(storeKey("hide", clientId)) === "1");
    setPick(readStore(storeKey("pick", clientId)));
  }, [clientId]);
  const load = useCallback(async () => {
    const res = await fetch("/api/room/money", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setM(await res.json());
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);
  useRoomEvent(() => { void load(); });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  if (!data || !m) return null;
  const rows = moneyRows(m);
  const top = pickedRow(m, pick);
  const fmt = (s: string) => money(s);
  function choose(key: string) {
    setPick(key);
    writeStore(storeKey("pick", clientId), key);
  }
  function toggleHide() {
    const next = !hidden;
    setHidden(next);
    writeStore(storeKey("hide", clientId), next ? "1" : null);
  }
  function copy(n: string) {
    void navigator.clipboard?.writeText(n).then(() => { setCopied(n); setTimeout(() => setCopied(""), 1400); });
  }

  return (
    <div className={`r-money${compact ? " is-compact" : ""}`} ref={box}>
      <button type="button" className="r-head-bal r-head-wallet r-money-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        aria-label={hidden ? `${top.label}, balance hidden` : `${top.label} ${money(top.amount)} ${top.currency}`}>
        <span style={{ color: "var(--r-muted)", display: "inline-flex" }}><WalletIcon /></span>
        {shown(top.amount, hidden, fmt)}{compact ? null : <span style={{ color: "var(--r-muted)", fontWeight: 400 }}>{top.currency}</span>}
        {compact ? null : <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--r-muted)" strokeWidth="1.5" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>}
      </button>
      {open ? (
        <div className="r-money-menu" role="menu" aria-label="Your money">
          <div className="r-money-actions">
            {ACTIONS.map((a) => (
              <a key={a.href} href={a.href} className="r-money-act" role="menuitem">
                <span className="r-money-act-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={a.d} /></svg></span>
                {a.label}
              </a>
            ))}
          </div>
          <label className="r-money-hide">
            <span>Hide balance</span>
            <input type="checkbox" role="switch" checked={hidden} onChange={toggleHide} />
            <span className="r-switch" aria-hidden="true" />
          </label>
          <div className="r-money-list">
            {rows.map((r) => {
              const on = r.key === top.key;
              return (
                <div key={r.key} className="r-money-row" data-selected={on}>
                  <button type="button" className="r-money-pick" role="menuitemradio" aria-checked={on} onClick={() => choose(r.key)}>
                    <span className="mono r-money-amt">{shown(r.amount, hidden, fmt)} <span className="r-money-ccy">{r.currency}</span>{r.key === "overall" && m.partial && !hidden ? <span className="r-money-ccy" title="An account in another currency has no price to convert it now"> · partial</span> : null}</span>
                    <span className="r-money-label">{r.label}{r.number && r.key !== "wallet" && r.key !== "partner" ? <span className="mono" style={{ fontSize: 11 }}> · {r.number}</span> : null}</span>
                  </button>
                  {r.number && r.key !== "wallet" && r.key !== "partner" ? (
                    <button type="button" className="r-money-copy" aria-label={`Copy ${r.number}`} title={copied === r.number ? "Copied" : "Copy account number"} onClick={() => copy(r.number!)}>
                      {copied === r.number
                        ? <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--r-ok)" strokeWidth="1.8" aria-hidden="true"><path d="m2.5 7.5 3 3 6-6" /></svg>
                        : <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="4.5" y="4.5" width="7.5" height="7.5" rx="1.2" /><path d="M9.5 4.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5" /></svg>}
                    </button>
                  ) : null}
                  <span className="r-money-check" aria-hidden="true">{on ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--r-accent)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m2.5 7.5 3 3 6-6" /></svg> : null}</span>
                  <a className="r-money-go" href={r.href} aria-label={`Open ${r.label}${r.number ? ` ${r.number}` : ""}`} title="Open">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 2.5 4.5 4.5L5 11.5" /></svg>
                  </a>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
