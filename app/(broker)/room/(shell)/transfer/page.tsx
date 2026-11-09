"use client";

import { useEffect, useMemo, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom } from "@/components/room/RoomData";
import { OpenAccountButton } from "@/components/room/OpenAccountModal";
import { useFunds, amountOk, cleanAmount } from "@/components/room/useFunds";
import { money, dayTime } from "@/components/room/format";

// Artboard "Internal transfer": between the client's own accounts, instant, free-margin check on the server.
export default function RoomTransfer() {
  const { data, refresh } = useRoom();
  const accounts = useMemo(() => [...(data?.accounts ?? []), ...(data?.wallet ? [data.wallet] : [])], [data]);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  // ?from=<id> / ?to=<id> from an account card or the wallet
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setFromId(q.get("from") ?? "");
    setToId(q.get("to") ?? "");
  }, []);
  const from = accounts.find((a) => a.id === fromId) ?? accounts.find((a) => a.mode === "LIVE") ?? accounts[0] ?? null;
  const targets = accounts.filter((a) => a.id !== from?.id && a.mode === from?.mode && a.currency === from?.currency);
  const to = targets.find((a) => a.id === toId) ?? targets[0] ?? null;
  useEffect(() => { if (to && toId !== to.id) setToId(to.id); }, [to, toId]);
  const { funds, reload } = useFunds(from?.id);
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!from || !to || busy) return;
    if (!amountOk(amount)) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/room/transfer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fromId: from.id, toId: to.id, amount: cleanAmount(amount) }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Transfer failed." }); return; }
    setMsg({ ok: true, text: `${money(cleanAmount(amount))} ${from.currency} moved to ${to.accountNumber}.` });
    setAmount("");
    await Promise.all([reload(), refresh()]);
  }

  const opt = (a: (typeof accounts)[number]) => `${a.accountNumber} · ${money(a.figures.balance)} ${a.currency}`;
  const label = { fontSize: 10.5, letterSpacing: 1.2 } as const;
  return (
    <>
      <RoomHeader title="Internal transfer" />
      <div className="r-body" style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div className="r-card" style={{ flex: "2 1 460px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="r-field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="tfrom" style={label}>From</label>
              <select id="tfrom" className="r-input mono" style={{ fontSize: 13, padding: "11px 12px" }} value={from?.id ?? ""} onChange={(e) => { setFromId(e.target.value); setToId(""); setMsg(null); }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{opt(a)}</option>)}
              </select>
            </div>
            <div className="r-field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="tto" style={label}>To</label>
              <select id="tto" className="r-input mono" style={{ fontSize: 13, padding: "11px 12px" }} value={to?.id ?? ""} onChange={(e) => { setToId(e.target.value); setMsg(null); }} disabled={targets.length === 0}>
                {targets.map((a) => <option key={a.id} value={a.id}>{opt(a)}</option>)}
              </select>
            </div>
          </div>
          <div className="r-field" style={{ maxWidth: 280 }}>
            <label htmlFor="tamt" style={label}>Amount · {from?.currency ?? "USD"}</label>
            <input id="tamt" className="r-input mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ padding: "10px 12px" }} />
            {funds ? <div style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Free to move: <span className="mono" style={{ color: "var(--r-text)" }}>{money(funds.available)} {from?.currency}</span></div> : null}
          </div>
          {targets.length === 0 && from ? <div className="r-note">You need a second {from.mode === "LIVE" ? "live" : "demo"} account in {from.currency} to transfer. <OpenAccountButton className="r-link-btn">Open an account</OpenAccountButton></div> : null}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", borderTop: "1px solid var(--r-line)", paddingTop: 18 }}>
            <div style={{ fontSize: 12, color: "var(--r-muted)", maxWidth: 420, lineHeight: 1.6 }}>Transfers between your own accounts are instant and free. Free margin on the source account must cover the amount.</div>
            <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={!from || !to || busy} onClick={submit}>{busy ? "Moving…" : "Transfer"}</button>
          </div>
          {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
        </div>

        <div className="r-card r-pad" style={{ flex: "1 1 300px", minWidth: 0 }}>
          <div className="r-label" style={{ marginBottom: 14 }}>Recent transfers</div>
          {funds && funds.transfers.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
              {funds.transfers.map((t, i) => (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: i < funds.transfers.length - 1 ? "1px solid var(--r-row)" : "none", paddingBottom: i < funds.transfers.length - 1 ? 12 : 0 }}>
                  <div>
                    <div className="mono">{t.account}</div>
                    <div style={{ color: "var(--r-muted)", fontSize: 11.5, marginTop: 3 }}>{dayTime(t.at)}</div>
                  </div>
                  <span className="mono">{money(t.amount)}</span>
                </div>
              ))}
            </div>
          ) : <div style={{ fontSize: 12.5, color: "var(--r-muted)" }}>No transfers yet.</div>}
        </div>
      </div>
    </>
  );
}
