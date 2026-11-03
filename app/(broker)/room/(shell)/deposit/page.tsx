"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom } from "@/components/room/RoomData";
import { useFunds, amountOk, cleanAmount, readDataUrl } from "@/components/room/useFunds";

// Artboard "Deposit": broker-configured methods, the broker's own receiving details with a payment reference,
// receipt upload, request to the broker.
export default function RoomDeposit() {
  const { data, selected, select, refresh } = useRoom();
  // ?account=<id> from a Deposit button elsewhere picks that account once
  const picked = useRef(false);
  useEffect(() => {
    if (picked.current || !data) return;
    picked.current = true;
    const wanted = new URLSearchParams(window.location.search).get("account");
    if (wanted && data.accounts.some((a) => a.id === wanted)) select(wanted);
  }, [data, select]);
  const live = useMemo(() => (data?.accounts ?? []).filter((a) => a.mode === "LIVE"), [data]);
  const account = selected?.mode === "LIVE" ? selected : live[0] ?? null;
  const { funds, reload } = useFunds(account?.id);
  const [methodId, setMethodId] = useState("");
  const method = funds?.methods.find((m) => m.id === methodId) ?? funds?.methods[0] ?? null;
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<{ name: string; size: number; data: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { setMsg({ ok: false, text: "Receipt is larger than 8 MB." }); return; }
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(f.type)) { setMsg({ ok: false, text: "Receipt must be JPG, PNG or PDF." }); return; }
    setReceipt({ name: f.name, size: f.size, data: await readDataUrl(f) });
    setMsg(null);
  }

  function copyDetails() {
    if (!funds || !method) return;
    const lines = method.bank
      ? [`Beneficiary: ${method.bank.beneficiary}`, `Bank: ${method.bank.bank}`, `IBAN / Account no.: ${method.bank.iban}`, `SWIFT: ${method.bank.swift}`]
      : method.wallet ? [`${method.label} address: ${method.wallet}`] : [];
    void navigator.clipboard?.writeText([...lines, `Reference: ${funds.reference}`].join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); });
  }

  async function submit() {
    if (!funds || !method || busy) return;
    if (!amountOk(amount)) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/room/deposit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: funds.account.id, methodId: method.id, amount: cleanAmount(amount), reference: funds.reference, receipt: receipt?.data ?? null }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Could not send the request." }); return; }
    setMsg({ ok: true, text: `Request sent. Reference ${funds.reference}.` });
    setAmount("");
    setReceipt(null);
    await Promise.all([reload(), refresh()]);
  }

  const label = { fontSize: 10.5, letterSpacing: 1.2 } as const;
  return (
    <>
      <RoomHeader title="Deposit" />
      <div className="r-body" style={{ gap: 18 }}>
        {data && live.length === 0 ? <div className="r-card r-pad r-note">Open a live account first. Demo accounts are not funded. <a href="/room/accounts#open">Open an account</a></div> : null}
        <div className="r-row">
          <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="r-label" style={{ padding: "2px 2px 4px" }}>Payment method</div>
            {(funds?.methods ?? []).map((m) => {
              const sel = method?.id === m.id;
              return (
                <button key={m.id} type="button" aria-pressed={sel} onClick={() => { setMethodId(m.id); setMsg(null); }}
                  style={{ textAlign: "left", background: sel ? "var(--r-gold-tint)" : "var(--r-card)", border: sel ? "1.5px solid var(--r-accent)" : "1px solid var(--r-border)", borderRadius: 10, padding: 16, cursor: "pointer", color: "var(--r-text)", display: "flex", flexDirection: "column", gap: 5 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{m.label}</span>
                  <span style={{ fontSize: 11.5, color: "var(--r-text-2)" }}>{[`Min ${Number(m.min).toLocaleString("en-US")} ${funds?.account.currency ?? ""}`, m.processing].filter(Boolean).join(" · ")}</span>
                </button>
              );
            })}
            {funds && funds.methods.length === 0 ? <div className="r-note">Your broker has no deposit methods open right now.</div> : null}
            <div style={{ fontSize: 11.5, color: "var(--r-faint)", lineHeight: 1.6, padding: "6px 2px" }}>Funds are received directly by your broker. QoreTrader does not hold client money.</div>
          </div>

          <div className="r-card" style={{ flex: "2 1 480px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <div className="r-field" style={{ flex: "1 1 200px" }}>
                <label htmlFor="acct" style={label}>To account</label>
                <select id="acct" className="r-input mono" style={{ fontSize: 13, padding: "11px 12px" }} value={account?.id ?? ""} onChange={(e) => { select(e.target.value); setMsg(null); }}>
                  {live.map((a) => <option key={a.id} value={a.id}>{`${a.accountNumber} · ${a.plan}`}</option>)}
                </select>
              </div>
              <div className="r-field" style={{ flex: "1 1 200px" }}>
                <label htmlFor="amt" style={label}>Amount · {account?.currency ?? "USD"}</label>
                <input id="amt" className="r-input mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ padding: "10px 12px" }} />
              </div>
            </div>

            {method && funds ? (
              <div style={{ background: "var(--r-card-2)", border: "1px solid var(--r-border)", borderRadius: 8, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="r-label">Transfer to</div>
                {method.bank ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 12.5 }}>
                    {([["Beneficiary", method.bank.beneficiary], ["Bank", method.bank.bank], ["IBAN / Account no.", method.bank.iban], ["SWIFT", method.bank.swift]] as const).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 3 }}>{k}</div><div className="mono" style={{ wordBreak: "break-all" }}>{v}</div></div>
                    ))}
                  </div>
                ) : method.wallet ? (
                  <div style={{ fontSize: 12.5 }}><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 3 }}>{method.label} address</div><div className="mono" style={{ wordBreak: "break-all" }}>{method.wallet}</div></div>
                ) : null}
                {method.instructions ? <div style={{ fontSize: 12, color: "var(--r-text-2)", lineHeight: 1.6, whiteSpace: "pre-line" }}>{method.instructions}</div> : null}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--r-line)", paddingTop: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 3 }}>Payment reference. Include it in your transfer.</div>
                    <div className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: "var(--r-gold-text)" }}>{funds.reference}</div>
                  </div>
                  <button type="button" className="r-btn-ghost" style={{ fontSize: 12, padding: "7px 14px" }} onClick={copyDetails}>{copied ? "Copied" : "Copy details"}</button>
                </div>
              </div>
            ) : null}

            <div style={{ border: "1px dashed var(--r-dash)", borderRadius: 8, padding: 18, display: "flex", alignItems: "center", gap: 14, background: "var(--r-card-2)", flexWrap: "wrap" }}>
              <svg width="22" height="22" viewBox="0 0 26 26" fill="none" stroke={receipt ? "var(--r-ok)" : "var(--r-muted)"} strokeWidth="1.4" aria-hidden="true"><path d="M6 3h10l4 4v16H6Z" /><path d="M16 3v4h4M9.5 13h7M9.5 16.5h7" /></svg>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{receipt ? receipt.name : "Attach transfer receipt"}</div>
                <div style={{ fontSize: 11.5, color: receipt ? "var(--r-ok)" : "var(--r-muted)", marginTop: 2 }}>{receipt ? `${(receipt.size / 1024 / 1024).toFixed(1)} MB` : "Speeds up approval · JPG, PNG or PDF"}</div>
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
              {receipt
                ? <button type="button" onClick={() => setReceipt(null)} style={{ background: "none", border: "none", color: "var(--r-loss)", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}>Remove</button>
                : <button type="button" className="r-btn-ghost" style={{ fontSize: 12.5, padding: "8px 16px" }} onClick={() => fileRef.current?.click()}>Choose file</button>}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, color: "var(--r-muted)" }}>Your broker credits the deposit after checking the payment.</div>
              <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={!funds || !method || busy || funds.account.mode !== "LIVE"} onClick={submit}>{busy ? "Sending…" : "Submit deposit request"}</button>
            </div>
            {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
          </div>
        </div>
      </div>
    </>
  );
}
