"use client";

import { useMemo, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import StatusChip from "@/components/room/StatusChip";
import { useRoom } from "@/components/room/RoomData";
import MethodGrid from "@/components/room/MethodGrid";
import { useFunds, amountOk, cleanAmount } from "@/components/room/useFunds";
import { money, dayTime } from "@/components/room/format";

// Artboard "Withdraw": from-account + available amount, saved own-name payout methods, request to the broker,
// verification card, processing card, pending requests.
const KYC_CARD: Record<string, { status: string; text: string }> = {
  APPROVED: { status: "Approved", text: "Your account is verified. Withdrawal requests go straight to processing." },
  PENDING: { status: "Under review", text: "Your documents are with your broker. Withdrawals open once they are approved." },
  REJECTED: { status: "Rejected", text: "Your documents were not accepted. Upload new ones to withdraw." },
  NONE: { status: "Not verified", text: "Complete KYC before your first withdrawal." },
};
const NETWORKS = [
  { type: "BANK_TRANSFER", label: "Bank account" },
  { type: "USDT_TRC20", label: "Tether (USDT TRC20)" },
  { type: "USDT_BEP20", label: "Tether (USDT BEP20)" },
  { type: "BTC", label: "Bitcoin" },
  { type: "ETH", label: "Ethereum" },
];

export default function RoomWithdraw() {
  const { data, selected, select, refresh } = useRoom();
  const live = useMemo(() => (data?.accounts ?? []).filter((a) => a.mode === "LIVE"), [data]);
  const account = selected?.mode === "LIVE" ? selected : live[0] ?? null;
  const { funds, reload, setFunds } = useFunds(account?.id);
  const [amount, setAmount] = useState("");
  const [payoutId, setPayoutId] = useState("");
  const [methodId, setMethodId] = useState("");
  const open = useMemo(() => funds?.methods.filter((m) => m.available) ?? [], [funds]);
  const method = open.find((m) => m.id === methodId) ?? open[0] ?? null;
  const saved = useMemo(() => funds?.payoutMethods.filter((p) => p.type === method?.type) ?? [], [funds, method]);
  const payout = saved.find((p) => p.id === payoutId) ?? saved[0] ?? null;
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: "BANK_TRANSFER", bank: "", account: "", swift: "", address: "" });
  const [addMsg, setAddMsg] = useState("");
  const [addNeedsCode, setAddNeedsCode] = useState(false);
  const [addCode, setAddCode] = useState("");
  const canAdd = Boolean(method && NETWORKS.some((n) => n.type === method.type));

  async function submit() {
    if (!funds || !payout || busy) return;
    if (!amountOk(amount)) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/room/withdraw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: funds.account.id, payoutMethodId: payout.id, amount: cleanAmount(amount), ...(needCode ? { code } : {}) }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (body?.code === "TWO_FACTOR_REQUIRED") { setNeedCode(true); setMsg({ ok: false, text: "Enter the code from your authenticator app." }); return; }
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Could not send the request." }); return; }
    setCode("");
    setMsg({ ok: true, text: body.status === "COMPLETED" ? "Withdrawal approved." : "Request sent to your broker." });
    setAmount("");
    await Promise.all([reload(), refresh()]);
  }

  async function addMethod() {
    setAddMsg("");
    const res = await fetch("/api/room/payout-methods", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, type: method?.type, ...(addNeedsCode ? { code: addCode } : {}) }) });
    const body = await res.json().catch(() => null);
    if (body?.code === "TWO_FACTOR_REQUIRED") setAddNeedsCode(true);
    if (!res.ok) { setAddMsg(body?.error ?? "Could not save."); return; }
    setAddNeedsCode(false);
    setAddCode("");
    if (funds) setFunds({ ...funds, payoutMethods: body.payoutMethods });
    setPayoutId(body.payoutMethods[body.payoutMethods.length - 1]?.id ?? "");
    setAdding(false);
    setForm({ type: form.type, bank: "", account: "", swift: "", address: "" });
  }

  const kyc = KYC_CARD[funds?.kyc ?? data?.kyc.status ?? "NONE"] ?? KYC_CARD.NONE;
  const minW = method && Number(method.withdraw.min) > 0 ? Number(method.withdraw.min) : null;
  const fee = funds?.methods.find((m) => m.feeLine)?.feeLine ?? "0.00";
  const ccy = account?.currency ?? "USD";
  const label = { fontSize: 10.5, letterSpacing: 1.2 } as const;
  return (
    <>
      <RoomHeader title="Withdraw" />
      <div className="r-body" style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div className="r-card" style={{ flex: "2 1 480px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div className="r-field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="wacct" style={label}>From account</label>
              <select id="wacct" className="r-input mono" style={{ fontSize: 13, padding: "11px 12px" }} value={account?.id ?? ""} onChange={(e) => { select(e.target.value); setMsg(null); }}>
                {live.map((a) => <option key={a.id} value={a.id}>{`${a.accountNumber} · ${a.plan}`}</option>)}
              </select>
              <div style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Available for withdrawal: <span className="mono" style={{ color: "var(--r-text)" }}>{funds ? `${money(funds.available)} ${ccy}` : "0.00"}</span></div>
            </div>
            <div className="r-field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="wamt" style={label}>Amount · {ccy}</label>
              <input id="wamt" className="r-input mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ padding: "10px 12px" }} />
              <button type="button" onClick={() => funds && setAmount(funds.available)} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--r-gold-text)", fontSize: 12, fontWeight: 500, padding: 0, cursor: "pointer" }}>Withdraw maximum</button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="r-label">Payout method</div>
            <MethodGrid side="withdraw" methods={funds?.methods ?? []} selectedId={method?.id ?? null} currency={ccy} onSelect={(id) => { setMethodId(id); setPayoutId(""); setAdding(false); setAddMsg(""); setMsg(null); }} />
            {saved.map((p) => {
              const sel = payout?.id === p.id;
              return (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 12, background: sel ? "var(--r-gold-tint)" : "var(--r-card)", border: sel ? "1.5px solid var(--r-accent)" : "1px solid var(--r-border)", borderRadius: 8, padding: "14px 16px", cursor: "pointer" }}>
                  <input type="radio" name="pm" checked={sel} onChange={() => setPayoutId(p.id)} style={{ accentColor: "var(--r-accent)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.title}</div>
                    <div style={{ fontSize: 11.5, color: "var(--r-text-2)", marginTop: 2 }}>{p.sub} · {p.verified ? "verified" : "awaiting check"}</div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--r-ok)", fontWeight: 600 }}>SAVED</span>
                </label>
              );
            })}
            {adding ? (
              <div style={{ border: "1px solid var(--r-border)", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 12, background: "var(--r-card-2)" }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {method?.type === "BANK_TRANSFER" ? (
                    <>
                      <div className="r-field" style={{ flex: "1 1 160px" }}><label htmlFor="pmbank" style={label}>Bank</label><input id="pmbank" className="r-input" value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} /></div>
                      <div className="r-field" style={{ flex: "2 1 220px" }}><label htmlFor="pmacc" style={label}>IBAN / Account no.</label><input id="pmacc" className="r-input mono" value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} /></div>
                      <div className="r-field" style={{ flex: "1 1 120px" }}><label htmlFor="pmswift" style={label}>SWIFT</label><input id="pmswift" className="r-input mono" value={form.swift} onChange={(e) => setForm({ ...form, swift: e.target.value })} /></div>
                    </>
                  ) : (
                    <div className="r-field" style={{ flex: "3 1 280px" }}><label htmlFor="pmaddr" style={label}>Your {method?.label} address</label><input id="pmaddr" className="r-input mono" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Account holder: {data?.client.fullName}. Accounts in another name are refused.</div>
                {addNeedsCode ? (
                  <div className="r-field" style={{ maxWidth: 220 }}>
                    <label htmlFor="pmcode" style={label}>Authenticator code</label>
                    <input id="pmcode" className="r-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={addCode} onChange={(e) => setAddCode(e.target.value.replace(/\D/g, ""))} />
                  </div>
                ) : null}
                {addMsg ? <div className="r-error">{addMsg}</div> : null}
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" className="r-btn r-btn-sm" onClick={addMethod}>Save method</button>
                  <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => { setAdding(false); setAddMsg(""); }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setAdding(true)} disabled={!canAdd} style={{ alignSelf: "flex-start", background: "none", border: "none", color: "var(--r-gold-text)", fontSize: 12.5, fontWeight: 500, padding: "2px 0", cursor: "pointer" }}>Add a payout method</button>
            )}
          </div>

          {needCode ? (
            <div className="r-field" style={{ maxWidth: 200 }}>
              <label htmlFor="wcode" style={label}>Authenticator code</label>
              <input id="wcode" className="r-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ padding: "10px 12px" }} />
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap", borderTop: "1px solid var(--r-line)", paddingTop: 18 }}>
            <div style={{ fontSize: 12, color: "var(--r-muted)", maxWidth: 380, lineHeight: 1.6 }}>Withdrawals are paid only to accounts in your own name and are reviewed by your broker before payout.</div>
            <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={!funds || !payout || busy || funds.kyc !== "APPROVED"} onClick={submit}>{busy ? "Sending…" : "Request withdrawal"}</button>
          </div>
          {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
        </div>

        <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="r-card r-pad">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="r-label">Verification</div>
              <StatusChip status={kyc.status} />
            </div>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", lineHeight: 1.6 }}>{kyc.text}{funds && funds.kyc !== "APPROVED" && funds.kyc !== "PENDING" ? <> <a href="/room/verify">Verify now</a></> : null}</div>
          </div>
          <div className="r-card r-pad">
            <div className="r-label" style={{ marginBottom: 14 }}>Processing</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12.5, color: "var(--r-text-2)" }}>
              {minW != null ? <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>Minimum</span><span className="mono" style={{ color: "var(--r-text)" }}>{money(minW)} {ccy}</span></div> : null}
              {method?.withdraw.processing ? <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{method.label}</span><span className="mono" style={{ color: "var(--r-text)" }}>{method.withdraw.processing}</span></div> : null}
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>Platform fee</span><span className="mono" style={{ color: "var(--r-text)" }}>{fee}</span></div>
            </div>
          </div>
          <div className="r-card r-pad">
            <div className="r-label" style={{ marginBottom: 14 }}>Pending requests</div>
            {funds && funds.pendingWithdrawals.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12.5 }}>
                {funds.pendingWithdrawals.map((p) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ color: "var(--r-text-2)" }}>{dayTime(p.at)}</span>
                    <span className="mono">{money(p.amount)}</span>
                  </div>
                ))}
              </div>
            ) : <div style={{ fontSize: 12.5, color: "var(--r-muted)" }}>No pending withdrawals.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
