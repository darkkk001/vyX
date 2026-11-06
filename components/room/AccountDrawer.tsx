"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RoomAccount } from "./RoomData";
import { tradingPasswordRules } from "@/lib/room/password-rules";

// Settings of one account, in a panel from the right (the three-dot on an account card). Every change goes through
// PATCH /api/room/accounts/[id] or /api/room/leverage, and each refusal shows where it was pressed.
export type LevRow = { accountId: string; current: number; ceiling: number; options: number[]; pending: { to: number; at: string } | null };
type Msg = { ok: boolean; text: string } | null;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid var(--r-line)" }}>
      <div className="r-flabel">{label}</div>
      {children}
    </div>
  );
}
const Note = ({ msg }: { msg: Msg }) => (msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null);

function Copy({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { setDone(false); }
  }
  return (
    <Row label={label}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span className="mono" style={{ fontSize: 13.5, minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
        <button type="button" className="r-btn-ghost r-btn-sm" aria-label={`Copy ${label.toLowerCase()}`} style={{ padding: "5px 10px", flexShrink: 0 }} onClick={copy}>{done ? "Copied" : "Copy"}</button>
      </div>
    </Row>
  );
}

function PasswordForm({ action, label, onDone, patch }: { action: string; label: string; onDone: (m: string) => void; patch: (b: object) => Promise<{ ok: boolean; error?: string }> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const rules = tradingPasswordRules(next);
  async function save() {
    if (busy) return;
    if (!rules.every((r) => r.ok)) { setMsg({ ok: false, text: "The password does not meet the rules." }); return; }
    setBusy(true);
    const r = await patch({ action, current, next });
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Could not save." }); return; }
    onDone(`${label} saved. This account's other sessions were signed out.`);
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input className="r-input" type="password" aria-label="Portal password" placeholder="Portal password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="r-input mono" type="password" aria-label={`New ${label.toLowerCase()}`} placeholder={`New ${label.toLowerCase()}`} autoComplete="new-password" maxLength={15} value={next} onChange={(e) => setNext(e.target.value)} />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        {rules.map((r) => <li key={r.label} style={{ fontSize: 11.5, color: r.ok ? "var(--r-ok)" : "var(--r-muted)" }}>{r.label}</li>)}
      </ul>
      <Note msg={msg} />
      <button type="button" className="r-btn r-btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
    </div>
  );
}

export default function AccountDrawer({ account, lev, onClose, onChanged }: { account: RoomAccount; lev: LevRow | null; onClose: () => void; onChanged: () => Promise<void> | void }) {
  const close = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<"" | "trading" | "investor">("");
  const [msg, setMsg] = useState<Msg>(null);
  const [nick, setNick] = useState(account.nickname ?? "");
  const [nickMsg, setNickMsg] = useState<Msg>(null);
  const [levNew, setLevNew] = useState(lev?.options.find((o) => o !== lev.current) ?? lev?.current ?? 0);
  const [levMsg, setLevMsg] = useState<Msg>(null);
  const [offPw, setOffPw] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archMsg, setArchMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  async function patch(body: object): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/room/accounts/${account.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const b = await res.json().catch(() => null);
    return res.ok ? { ok: true } : { ok: false, error: b?.error ?? "Could not save." };
  }
  const saved = (text: string) => { setPanel(""); setMsg({ ok: true, text }); void onChanged(); };

  async function saveNick() {
    const r = await patch({ action: "nickname", nickname: nick });
    setNickMsg(r.ok ? { ok: true, text: "Saved." } : { ok: false, text: r.error ?? "Could not save." });
    if (r.ok) await onChanged();
  }
  async function applyLeverage() {
    if (!lev || busy) return;
    setBusy(true);
    const res = await fetch("/api/room/leverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, leverage: levNew }) });
    const b = await res.json().catch(() => null);
    setBusy(false);
    setLevMsg(res.ok ? { ok: true, text: b.status === "pending" ? `Request sent: 1:${levNew}.` : `Leverage is now 1:${levNew}.` } : { ok: false, text: b?.error ?? "Could not change leverage." });
    if (res.ok) await onChanged();
  }
  async function archive() {
    setBusy(true);
    const r = await patch({ action: "archive" });
    setBusy(false);
    if (!r.ok) { setArchMsg({ ok: false, text: r.error ?? "Could not archive." }); setArchiving(false); return; }
    await onChanged();
    onClose();
  }
  async function readOnlyOff() {
    const r = await patch({ action: "investor-password-off", current: offPw });
    if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Could not save." }); return; }
    setOffPw("");
    saved("Read-only password removed.");
  }

  return (
    <div className="r-panel-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="r-panel" role="dialog" aria-modal="true" aria-label="Account settings">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: 14 }}>
          <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>Settings</div>
          <button ref={close} type="button" className="r-icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        <Copy label="Server" value={account.server} />
        <Copy label="Login" value={account.accountNumber} />
        <Row label="Plan">
          <div style={{ fontSize: 13.5 }}>{account.plan} · {account.mode === "LIVE" ? "Real" : "Demo"}</div>
        </Row>
        <Row label="Trading password">
          {panel === "trading"
            ? <PasswordForm action="trading-password" label="Trading password" patch={patch} onDone={saved} />
            : <button type="button" className="r-btn-ghost r-btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => { setMsg(null); setPanel("trading"); }}>Change trading password</button>}
        </Row>
        <Row label="Max leverage">
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 13.5 }}>1:{lev?.current ?? account.leverage}</span>
            {lev && lev.options.length > 1 && !lev.pending ? (
              <>
                <select aria-label="New leverage" className="r-input mono" style={{ padding: "6px 10px", fontSize: 12.5 }} value={levNew} onChange={(e) => setLevNew(Number(e.target.value))}>
                  {lev.options.map((o) => <option key={o} value={o} disabled={o === lev.current}>1:{o}</option>)}
                </select>
                <button type="button" className="r-btn-ghost r-btn-sm" style={{ padding: "6px 12px" }} disabled={busy || levNew === lev.current} onClick={applyLeverage}>Change</button>
              </>
            ) : null}
          </div>
          {lev?.pending ? <div className="r-chip-pending" style={{ fontSize: 12.5 }}>1:{lev.pending.to} is pending broker approval.</div> : null}
          <Note msg={levMsg} />
        </Row>
        <Row label="Read-only (investor) password">
          <div className="r-note">Lets someone view this account without trading.</div>
          {panel === "investor"
            ? <PasswordForm action="investor-password" label="Read-only password" patch={patch} onDone={saved} />
            : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => { setMsg(null); setPanel("investor"); }}>{account.readOnlyPassword ? "Change" : "Set password"}</button>
                {account.readOnlyPassword ? (
                  <>
                    <input className="r-input" type="password" aria-label="Portal password to remove" placeholder="Portal password" style={{ padding: "6px 10px", fontSize: 12.5, width: 150 }} value={offPw} onChange={(e) => setOffPw(e.target.value)} />
                    <button type="button" className="r-btn-ghost r-btn-sm" disabled={!offPw} onClick={readOnlyOff}>Remove</button>
                  </>
                ) : null}
              </div>
            )}
        </Row>
        <Note msg={msg} />
        <Row label="Nickname">
          <div style={{ display: "flex", gap: 8 }}>
            <input className="r-input" aria-label="Nickname" style={{ flex: 1, minWidth: 0, padding: "7px 10px", fontSize: 13 }} maxLength={30} value={nick} onChange={(e) => { setNick(e.target.value); setNickMsg(null); }} />
            <button type="button" className="r-btn-ghost r-btn-sm" onClick={saveNick}>Save</button>
          </div>
          <Note msg={nickMsg} />
        </Row>
        <Row label="Statements">
          <a href={`/room/history?account=${account.id}`} style={{ fontSize: 13, fontWeight: 500 }}>View statements</a>
        </Row>
        <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--r-line)", display: "flex", flexDirection: "column", gap: 10 }}>
          <Note msg={archMsg} />
          {archiving ? <div className="r-note">Archive this account? You can restore it later.</div> : null}
          <div style={{ display: "flex", gap: 10 }}>
            {archiving ? (
              <>
                <button type="button" className="r-btn-ghost" style={{ flex: 1 }} onClick={() => setArchiving(false)}>Keep</button>
                <button type="button" className="r-btn" style={{ flex: 1 }} disabled={busy} onClick={archive}>Archive</button>
              </>
            ) : (
              <>
                <button type="button" className="r-btn-ghost" style={{ flex: 1 }} onClick={() => { setArchMsg(null); setArchiving(true); }}>Archive</button>
                <a className="r-btn-ghost" style={{ flex: 1 }} href={`/room/transfer?from=${account.id}`}>Transfer</a>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
