"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { useFunds, amountOk, cleanAmount, readDataUrl, useSendOnce } from "@/components/room/useFunds";
import MethodGrid from "@/components/room/MethodGrid";
import AmountInput from "@/components/room/AmountInput";
import DepositStatus, { type DepositView } from "@/components/room/DepositStatus";
import { maxProcessingSeconds } from "@/lib/room/processing-time";
import { countdown } from "@/components/room/money-input";
import { money } from "@/components/room/format";
import { WALLET_KEY } from "@/lib/room/wallet-key";

// Artboard "Deposit": broker-configured methods, the broker's own receiving details with a payment reference,
// receipt upload, request to the broker. After a request (owner 2026-11-10): the confirmation card follows it live and comes
// back while it is pending; the same method waits 5 minutes ("Next request in 4:32", also refused by the server).
// Owner 2026-11-12: the method grid always shows. To account = the funding wallet (also before it exists: the first
// request creates it), the live accounts and the demo accounts. Identity not verified: every card locked with a Verify
// now link and the live form disabled (the server refuses too). A demo account: no methods, receipt or reference, only
// an amount with quick picks and Top up, credited at once by the same route as the dashboard Top up (100,000 cap).
const DISMISSED = "room_deposit_dismissed";
const DEMO_CAP = 100_000;
const QUICK = [1_000, 5_000, 10_000];
type Target = { key: string; id: string; accountNumber: string; mode: "LIVE" | "DEMO"; currency: string; balance: string; isWallet: boolean };
export default function RoomDeposit() {
  const { data, selected, select, refresh } = useRoom();
  // ?account=<id> from a Deposit button elsewhere picks that account once
  const picked = useRef(false);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const targets = useMemo<Target[]>(() => {
    if (!data) return [];
    const w = data.wallet;
    const wallet: Target = { key: WALLET_KEY, id: w?.id ?? WALLET_KEY, accountNumber: "Funding wallet", mode: "LIVE", currency: w?.currency ?? data.walletCurrency ?? "USD", balance: w?.figures.balance ?? "0", isWallet: true };
    const acct = (a: (typeof data.accounts)[number]): Target => ({ key: a.id, id: a.id, accountNumber: a.accountNumber, mode: a.mode, currency: a.currency, balance: a.figures.balance, isWallet: false });
    return [wallet, ...data.accounts.filter((a) => a.mode === "LIVE").map(acct), ...data.accounts.filter((a) => a.mode === "DEMO").map(acct)];
  }, [data]);
  useEffect(() => {
    if (picked.current || !data) return;
    picked.current = true;
    // ?account=<id> from a Deposit button elsewhere; else the account picked in the top bar when it is live; else the first
    // live account; else the funding wallet
    const wanted = new URLSearchParams(window.location.search).get("account");
    const live = data.accounts.filter((a) => a.mode === "LIVE");
    if (wanted && (wanted === data.wallet?.id || wanted === WALLET_KEY)) setTargetKey(WALLET_KEY);
    else if (wanted && data.accounts.some((a) => a.id === wanted)) setTargetKey(wanted);
    else setTargetKey(selected?.mode === "LIVE" ? selected.id : live[0]?.id ?? WALLET_KEY);
  }, [data, selected]);
  const account = targets.find((t) => t.key === targetKey) ?? null;
  const isDemo = account?.mode === "DEMO";
  const { funds, reload } = useFunds(account && !isDemo ? account.id : null);
  const kycStatus = funds?.kyc ?? data?.kyc.status ?? "NONE";
  const locked = !isDemo && kycStatus !== "APPROVED";
  const [methodId, setMethodId] = useState("");
  const open = funds?.methods.filter((m) => m.available) ?? [];
  const method = open.find((m) => m.id === methodId) ?? open[0] ?? null;
  const [addressCopied, setAddressCopied] = useState(false);
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<{ name: string; size: number; data: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // one request per form load; the button stays "Sending…" from the first click until the server answers
  const send = useSendOnce();
  const busy = send.busy;
  // the request the confirmation card follows (null = the form)
  const [status, setStatus] = useState<DepositView | null>(null);
  // per method: until when the next request waits; skew = server clock minus this browser's
  const [waits, setWaits] = useState<Record<string, string>>({});
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const loadState = useCallback(async (resume: boolean) => {
    const res = await fetch("/api/room/deposit", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const b = (await res.json()) as { pending: DepositView | null; cooldowns: Record<string, string>; now: string };
    setWaits(b.cooldowns);
    setSkew(new Date(b.now).getTime() - Date.now());
    let dismissed = "";
    try { dismissed = localStorage.getItem(DISMISSED) ?? ""; } catch { /* storage blocked */ }
    if (resume && b.pending && b.pending.id !== dismissed) setStatus((cur) => cur ?? b.pending);
  }, []);
  const loadStatus = useCallback(async (id: string) => {
    const res = await fetch(`/api/room/deposit?id=${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setStatus(await res.json());
  }, []);
  useEffect(() => { void loadState(true); }, [loadState]);
  // live: the broker's approve / reject reaches the room socket in ~1 s; a 15 s read while waiting covers a dropped socket
  useRoomEvent(() => { if (status) void loadStatus(status.id); void loadState(false); });
  useEffect(() => {
    if (status?.state !== "PENDING") return;
    const t = setInterval(() => void loadStatus(status.id), 15_000);
    return () => clearInterval(t);
  }, [status?.state, status?.id, loadStatus]);
  // the countdowns tick while any method waits
  const waiting = Object.values(waits).some((u) => new Date(u).getTime() > now + skew);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  const serverNow = now + skew;
  const methodWait = method && waits[method.id] && new Date(waits[method.id]).getTime() > serverNow ? waits[method.id] : null;
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
    if (!funds || !method) return;
    if (!amountOk(amount)) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    if (!send.begin()) return;
    setMsg(null);
    let res: Response | null = null;
    let body: { error?: string; code?: string; until?: string; id?: string; reference?: string; duplicate?: boolean } | null = null;
    try {
      res = await fetch("/api/room/deposit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: send.key, accountId: funds.account.id, methodId: method.id, amount: cleanAmount(amount), reference: funds.reference, receipt: receipt?.data ?? null }) });
      body = await res.json().catch(() => null);
    } catch { /* no connection: the message below */ }
    send.end();
    if (body?.code === "DEPOSIT_COOLDOWN" && body.until) { setWaits((w) => ({ ...w, [method.id]: body!.until! })); setNow(Date.now()); }
    if (!res || !res.ok || !body?.id) { setMsg({ ok: false, text: body?.error ?? "Could not send the request." }); return; }
    // the form is replaced by the confirmation card, so the same request cannot go twice; it follows the request live
    setStatus({ id: body.id, state: "PENDING", amount: cleanAmount(amount), currency: funds.account.currency, accountNumber: account?.isWallet ? "Funding wallet" : funds.account.accountNumber, method: method.label, reference: body.reference ?? funds.reference, sentAt: new Date().toISOString(), decidedAt: null, reason: null, balance: null, maxSeconds: maxProcessingSeconds(method.processing) });
    await Promise.all([loadStatus(body.id), loadState(false), reload(), refresh()]);
  }

  function another() {
    if (status) { try { localStorage.setItem(DISMISSED, status.id); } catch { /* storage blocked */ } }
    setStatus(null);
    void loadState(false);
    setAmount("");
    setReceipt(null);
    setMsg(null);
    send.renew();
  }

  // demo: credited at once, same route and checks as the dashboard Top up (POST /api/room/accounts/<id>/top-up)
  const topUp = useSendOnce();
  async function submitTopUp() {
    if (!account || !isDemo) return;
    if (!amountOk(amount)) { setMsg({ ok: false, text: "Enter an amount." }); return; }
    if (!topUp.begin()) return;
    setMsg(null);
    let res: Response | null = null;
    let body: { error?: string; amount?: string; balance?: string } | null = null;
    try {
      res = await fetch(`/api/room/accounts/${encodeURIComponent(account.id)}/top-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: topUp.key, amount: cleanAmount(amount) }) });
      body = await res.json().catch(() => null);
    } catch { /* no connection: the message below */ }
    topUp.end();
    if (!res || !res.ok || !body?.balance) { setMsg({ ok: false, text: body?.error ?? "Could not top up. Try again." }); return; }
    setMsg({ ok: true, text: `${money(body.amount ?? cleanAmount(amount))} ${account.currency} added. Balance ${money(body.balance)} ${account.currency}.` });
    setAmount("");
    topUp.renew();
    void refresh();
  }
  const demoRoom = isDemo && account ? Math.max(0, DEMO_CAP - Number(account.balance)) : 0;

  const label = { fontSize: 10.5, letterSpacing: 1.2 } as const;
  return (
    <>
      <RoomHeader title="Deposit" />
      <div className="r-body" style={{ gap: 18 }}>
        {isDemo ? null : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="r-label" style={{ padding: "2px 2px 4px" }}>Payment method</div>
            <MethodGrid methods={funds?.methods ?? []} selectedId={method?.id ?? null} currency={funds?.account.currency ?? ""} onSelect={(id) => { setMethodId(id); setMsg(null); }} waits={waits} now={serverNow} locked={locked} />
          </div>
        )}
        <div className="r-row">
          {!isDemo && !locked && funds && open.length === 0 ? (
            <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="r-note">No deposit methods are open right now.</div>
            </div>
          ) : null}

          {status ? (
            <div style={{ flex: "2 1 480px", minWidth: 0 }}>
              <DepositStatus v={status} onAgain={another} />
            </div>
          ) : (
          <div className="r-card" style={{ flex: "2 1 480px", minWidth: 0, padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
              <div className="r-field r-field-fixed">
                <label htmlFor="acct" style={label}>To account</label>
                <select id="acct" className="r-input mono" style={{ fontSize: 13, padding: "11px 12px" }} value={account?.key ?? ""} disabled={busy || topUp.busy} onChange={(e) => { const k = e.target.value; setTargetKey(k); if (k !== WALLET_KEY) select(k); setMsg(null); setAmount(""); }}>
                  {targets.map((t) => <option key={t.key} value={t.key}>{`${t.accountNumber}${t.mode === "DEMO" ? " · Demo" : ""} · ${money(t.balance)} ${t.currency}`}</option>)}
                </select>
              </div>
              <div className="r-field r-field-fixed">
                <label htmlFor="amt" style={label}>Amount</label>
                {/* typing clears a stale "Enter an amount." (it stayed red over a typed 500 until the next click) */}
                <AmountInput id="amt" currency={account?.currency} value={amount} disabled={locked || topUp.busy} onChange={(v) => { setAmount(v); if (msg && !msg.ok) setMsg(null); }} />
              </div>
            </div>

            {isDemo ? (
              <>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {QUICK.map((q) => <button key={q} type="button" className="r-btn-ghost mono" style={{ fontSize: 12.5, padding: "7px 14px" }} disabled={topUp.busy || q > demoRoom} onClick={() => { setAmount(String(q)); setMsg(null); }}>{q.toLocaleString("en-US")}</button>)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Demo money, credited at once. Up to <span className="mono" style={{ fontSize: 11.5 }}>{money(demoRoom)} {account?.currency}</span>; demo balances stay at or under {money(DEMO_CAP)}.</div>
                <div>
                  <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={topUp.busy || demoRoom <= 0} onClick={submitTopUp}>{topUp.busy ? "Adding…" : "Top up"}</button>
                </div>
              </>
            ) : locked ? (
              <div className="r-note">Verify your identity to deposit. <a href="/room/verify">Verify now</a></div>
            ) : null}

            {!isDemo && !locked && method && funds ? (
              <div style={{ background: "var(--r-card-2)", border: "1px solid var(--r-border)", borderRadius: 8, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="r-label">Transfer to</div>
                {method.bank ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 12.5 }}>
                    {([["Beneficiary", method.bank.beneficiary], ["Bank", method.bank.bank], ["IBAN / Account no.", method.bank.iban], ["SWIFT", method.bank.swift]] as const).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 3 }}>{k}</div><div className="mono" style={{ wordBreak: "break-all" }}>{v}</div></div>
                    ))}
                  </div>
                ) : method.wallet ? (
                  <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
                    {method.qr ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={method.qr} alt={`QR code of the ${method.label} address`} width={148} height={148} style={{ background: "#fff", borderRadius: 6, padding: 4 }} />
                    ) : null}
                    <div style={{ flex: "1 1 220px", minWidth: 0, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                      <div><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 3 }}>{method.label} address</div><div className="mono" data-wallet style={{ wordBreak: "break-all" }}>{method.wallet}</div></div>
                      <button type="button" className="r-btn-ghost" style={{ fontSize: 12, padding: "7px 14px" }} onClick={() => { void navigator.clipboard?.writeText(method.wallet!).then(() => { setAddressCopied(true); setTimeout(() => setAddressCopied(false), 1600); }); }}>{addressCopied ? "Copied" : "Copy address"}</button>
                    </div>
                  </div>
                ) : null}
                {method.warning ? <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--r-pending)", lineHeight: 1.5 }}>{method.warning}</div> : null}
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

            {isDemo ? null : (<>
            {locked ? null : <div style={{ border: "1px dashed var(--r-dash)", borderRadius: 8, padding: 18, display: "flex", alignItems: "center", gap: 14, background: "var(--r-card-2)", flexWrap: "wrap" }}>
              <svg width="22" height="22" viewBox="0 0 26 26" fill="none" stroke={receipt ? "var(--r-ok)" : "var(--r-muted)"} strokeWidth="1.4" aria-hidden="true"><path d="M6 3h10l4 4v16H6Z" /><path d="M16 3v4h4M9.5 13h7M9.5 16.5h7" /></svg>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{receipt ? receipt.name : "Attach transfer receipt"}</div>
                <div style={{ fontSize: 11.5, color: receipt ? "var(--r-ok)" : "var(--r-muted)", marginTop: 2 }}>{receipt ? `${(receipt.size / 1024 / 1024).toFixed(1)} MB` : "Speeds up approval · JPG, PNG or PDF"}</div>
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
              {receipt
                ? <button type="button" onClick={() => setReceipt(null)} style={{ background: "none", border: "none", color: "var(--r-loss)", fontSize: 12.5, fontWeight: 500, cursor: "pointer" }}>Remove</button>
                : <button type="button" className="r-btn-ghost" style={{ fontSize: 12.5, padding: "8px 16px" }} onClick={() => fileRef.current?.click()}>Choose file</button>}
            </div>}

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
              <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={locked || !funds || !method || busy || funds.account.mode !== "LIVE" || methodWait != null} onClick={submit}>{busy ? "Sending…" : methodWait ? `Next request in ${countdown(methodWait, serverNow)}` : "Submit deposit request"}</button>
            </div>
            </>)}
            {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
          </div>
          )}
        </div>
      </div>
    </>
  );
}
