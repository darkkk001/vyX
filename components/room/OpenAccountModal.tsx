"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoom } from "./RoomData";
import { money } from "./format";
import { tradingPasswordRules } from "@/lib/room/password-rules";

// Open new account: one popup on every Room screen, opened by openAccount(). Step 1 picks the plan, step 2 sets the account
// up. A real account is a request to the broker (KYC first); a demo account is created at once.
type Mode = "LIVE" | "DEMO";
type Plan = { groupId: string; name: string; spreadFrom: string | null; commissionPerLot: string | null; minDeposit: string | null; maxLeverage: number; leverageOptions: number[] };
type Meta = { plans: Plan[]; currencies: string[]; liveRequest: { at: string } | null; kycApproved: boolean; demoBalance: { min: number; max: number; default: number } };

const EVENT = "room:open-account";
export const openAccount = (mode: Mode = "LIVE") => window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));

export function OpenAccountButton({ mode, className, style, children }: { mode?: Mode; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return <button type="button" className={className} style={style} onClick={() => openAccount(mode)}>{children}</button>;
}

const lev = (n: number) => `1:${n}`;
const planCommission = (p: Plan) => (p.commissionPerLot && Number(p.commissionPerLot) > 0 ? `${money(p.commissionPerLot)} / lot` : "None");
const planDeposit = (p: Plan, ccy: string) => (p.minDeposit ? `${Number(p.minDeposit).toLocaleString("en-US")} ${ccy}` : "None");

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: "var(--r-muted)" }}>{label}</div>
      <div className="mono" style={{ fontSize: 12.5, marginTop: 3 }}>{value}</div>
    </div>
  );
}

export default function OpenAccountModal() {
  const { refresh } = useRoom();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [mode, setMode] = useState<Mode>("LIVE");
  const [metas, setMetas] = useState<Partial<Record<Mode, Meta>>>({});
  const [planName, setPlanName] = useState("");
  const [leverage, setLeverage] = useState(0);
  const [currency, setCurrency] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const read = async (m: Mode) => { const r = await fetch(`/api/room/accounts?mode=${m}`, { cache: "no-store" }); return r.ok ? ((await r.json()) as Meta) : undefined; };
    const [LIVE, DEMO] = await Promise.all([read("LIVE"), read("DEMO")]);
    setMetas({ LIVE, DEMO });
    if (!LIVE && !DEMO) setMsg({ ok: false, text: "Could not load the plans. Try again." });
  }, []);

  const show1 = useCallback((m: Mode) => {
    setMode(m); setStep(1); setPlanName(""); setNickname(""); setPassword(""); setShow(false); setStart(""); setMsg(null); setDone(false); setOpen(true);
    void load();
  }, [load]);

  useEffect(() => {
    const on = (e: Event) => show1(((e as CustomEvent).detail as Mode) ?? "LIVE");
    window.addEventListener(EVENT, on);
    // links from outside the shell (the verification screen) arrive as /room?open=1
    const q = new URLSearchParams(window.location.search);
    if (q.get("open") === "1") {
      show1("LIVE");
      q.delete("open");
      window.history.replaceState(null, "", window.location.pathname + (q.size ? `?${q}` : ""));
    }
    return () => window.removeEventListener(EVENT, on);
  }, [show1]);

  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  const meta = metas[mode];
  const plans = useMemo(() => meta?.plans ?? [], [meta]);
  const plan = plans.find((p) => p.name === planName) ?? plans[0] ?? null;
  const ccy = currency || meta?.currencies[0] || "USD";
  useEffect(() => { if (plan) setLeverage((l) => (plan.leverageOptions.includes(l) ? l : plan.leverageOptions[0])); }, [plan]);
  const rules = tradingPasswordRules(password);
  const blocked = mode === "LIVE" && meta ? (!meta.kycApproved ? "Complete KYC before opening a real account." : meta.liveRequest ? "Your real account request is under review." : "") : "";
  const startValue = start || String(meta?.demoBalance.default ?? "");

  async function create() {
    if (!plan || busy) return;
    if (!rules.every((r) => r.ok)) { setMsg({ ok: false, text: "The password does not meet the rules." }); return; }
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/room/accounts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, groupId: plan.groupId, leverage, currency: ccy, password, nickname, ...(mode === "DEMO" ? { startingBalance: startValue } : {}) }),
    });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Could not open the account." }); return; }
    setPassword("");
    setDone(true);
    setMsg({ ok: true, text: body.status === "created" ? `Demo account ${body.accountNumber} is ready.` : "Request sent. The account opens after review." });
    window.dispatchEvent(new Event("room:accounts-changed"));
    await refresh();
  }

  if (!open) return null;
  const toggle = (m: Mode, label: string) => (
    <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setMsg(null); }}
      style={{ flex: 1, background: mode === m ? "var(--r-accent)" : "none", color: mode === m ? "var(--r-on-accent)" : "var(--r-text-2)", border: "none", borderRadius: 5, fontSize: 12.5, fontWeight: mode === m ? 600 : 500, padding: "8px 18px", cursor: "pointer" }}>
      {label}
    </button>
  );
  return (
    <div className="r-modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="r-modal" role="dialog" aria-modal="true" aria-label={step === 1 ? "Open new account" : "Set up your account"}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 19, fontWeight: 600 }}>{step === 1 ? "Open new account" : "Set up your account"}</div>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 4 }}>{step === 1 ? "Pick a plan." : `${plan?.name ?? ""} plan`}</div>
          </div>
          <button ref={closeBtn} type="button" className="r-icon-btn" aria-label="Close" onClick={() => setOpen(false)}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
          </button>
        </div>

        {step === 1 ? (
          <>
            <div role="radiogroup" aria-label="Plan" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {plans.map((p) => {
                const sel = plan?.groupId === p.groupId;
                return (
                  <button key={p.groupId} type="button" role="radio" aria-checked={sel} onClick={() => setPlanName(p.name)} className="r-plan-row"
                    style={{ border: sel ? "1.5px solid var(--r-accent)" : "1px solid var(--r-input)", background: sel ? "var(--r-gold-tint)" : "var(--r-card-2)" }}>
                    <span style={{ fontFamily: "var(--r-head)", fontSize: 15, fontWeight: 600, color: "var(--r-text)" }}>{p.name}</span>
                    <span className="r-plan-figs">
                      {mode === "LIVE" ? <Figure label="Min deposit" value={planDeposit(p, ccy)} /> : null}
                      <Figure label="Min spread" value={p.spreadFrom ? `${p.spreadFrom} on major FX` : "See specifications"} />
                      <Figure label="Max leverage" value={lev(p.maxLeverage)} />
                      <Figure label="Commission" value={planCommission(p)} />
                    </span>
                  </button>
                );
              })}
              {meta && plans.length === 0 ? <div className="r-note">No plans are open right now.</div> : null}
              {!meta && !msg ? <div className="r-note">Loading plans…</div> : null}
            </div>
            <a href="/room/specifications" style={{ fontSize: 12.5, fontWeight: 500, alignSelf: "flex-start" }}>Contract specifications</a>
            {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button type="button" className="r-btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="r-btn" disabled={!plan} onClick={() => { setMsg(null); setStep(2); }}>Continue</button>
            </div>
          </>
        ) : done ? (
          <>
            {msg ? <div className="r-okmsg" role="status">{msg.text}</div> : null}
            <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" className="r-btn" onClick={() => setOpen(false)}>Done</button></div>
          </>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
            <div style={{ flex: "3 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
              <div role="group" aria-label="Account type" style={{ display: "flex", background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 7, padding: 3 }}>
                {toggle("LIVE", "Real")}
                {toggle("DEMO", "Demo")}
              </div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                <div className="r-field" style={{ flex: "1 1 130px" }}>
                  <label htmlFor="oa-cur">Currency</label>
                  <select id="oa-cur" className="r-input mono" value={ccy} onChange={(e) => setCurrency(e.target.value)}>{(meta?.currencies ?? []).map((c) => <option key={c}>{c}</option>)}</select>
                </div>
                <div className="r-field" style={{ flex: "1 1 130px" }}>
                  <label htmlFor="oa-lev">Max leverage</label>
                  <select id="oa-lev" className="r-input mono" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))}>{(plan?.leverageOptions ?? []).map((o) => <option key={o} value={o}>{lev(o)}</option>)}</select>
                </div>
              </div>
              <div className="r-field">
                <label htmlFor="oa-nick">Nickname (optional)</label>
                <input id="oa-nick" className="r-input" maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} />
              </div>
              {mode === "DEMO" && meta ? (
                <div className="r-field">
                  <label htmlFor="oa-bal">Starting balance · {ccy}</label>
                  <input id="oa-bal" className="r-input mono" inputMode="decimal" value={startValue} onChange={(e) => setStart(e.target.value)} />
                  <div className="r-note">{meta.demoBalance.min.toLocaleString("en-US")} to {meta.demoBalance.max.toLocaleString("en-US")}</div>
                </div>
              ) : null}
              <div className="r-field">
                <label htmlFor="oa-pw">Trading password</label>
                <div style={{ position: "relative" }}>
                  <input id="oa-pw" className="r-input mono" style={{ width: "100%", paddingRight: 58 }} type={show ? "text" : "password"} autoComplete="new-password" maxLength={15} value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" onClick={() => setShow(!show)} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--r-text-2)", fontSize: 12, cursor: "pointer" }}>{show ? "Hide" : "Show"}</button>
                </div>
                <ul aria-label="Password rules" style={{ listStyle: "none", margin: "2px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                  {rules.map((r) => (
                    <li key={r.label} data-ok={r.ok} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: r.ok ? "var(--r-ok)" : "var(--r-muted)" }}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{r.ok ? <path d="m2 6.5 3 3 5-7" /> : <circle cx="6" cy="6" r="4" />}</svg>
                      {r.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div style={{ flex: "2 1 200px", minWidth: 0, background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontFamily: "var(--r-head)", fontSize: 15, fontWeight: 600 }}>{plan?.name}</div>
              {plan ? (
                <>
                  {mode === "LIVE" ? <Figure label="Min deposit" value={planDeposit(plan, ccy)} /> : null}
                  <Figure label="Min spread" value={plan.spreadFrom ? `${plan.spreadFrom} on major FX` : "See specifications"} />
                  <Figure label="Max leverage" value={lev(plan.maxLeverage)} />
                  <Figure label="Commission" value={planCommission(plan)} />
                </>
              ) : <div className="r-note">This plan is not open for {mode === "LIVE" ? "real" : "demo"} accounts.</div>}
            </div>
            <div style={{ flex: "1 1 100%", display: "flex", flexDirection: "column", gap: 12 }}>
              {blocked ? <div className="r-note">{blocked}{!meta?.kycApproved ? <> <a href="/room/verify">Verify now</a></> : null}</div> : null}
              {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                <button type="button" className="r-btn-ghost" onClick={() => { setMsg(null); setStep(1); }}>Back</button>
                <button type="button" className="r-btn" disabled={!plan || busy || Boolean(blocked)} onClick={create}>{busy ? "Creating…" : mode === "LIVE" ? "Create Real account" : "Create Demo account"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
