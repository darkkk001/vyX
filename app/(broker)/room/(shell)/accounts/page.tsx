"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money, day } from "@/components/room/format";

// Artboard "Accounts · leverage · open account".
type Plan = { groupId: string; name: string; spreadFrom: string | null; commissionPerLot: string | null; minDeposit: string | null; maxLeverage: number; leverageOptions: number[] };
type LevRow = { accountId: string; current: number; ceiling: number; options: number[]; pending: { to: number; at: string } | null };
type Meta = { mode: "LIVE" | "DEMO"; plans: Plan[]; currencies: string[]; leverageReview: boolean; leverage: LevRow[]; liveRequest: { at: string } | null; kycApproved: boolean };

const th = (label: string, right = false) => (
  <th key={label} style={{ padding: "8px 10px", fontSize: 10.5, borderBottom: "1px solid var(--r-border)", textAlign: right ? "right" : "left" }}>{label}</th>
);
const td = { padding: "11px 10px" } as const;

export default function RoomAccounts() {
  const { data, refresh } = useRoom();
  const [mode, setMode] = useState<"LIVE" | "DEMO">("LIVE");
  const [meta, setMeta] = useState<Meta | null>(null);
  const load = useCallback(async (m: "LIVE" | "DEMO") => {
    const res = await fetch(`/api/room/accounts?mode=${m}`, { cache: "no-store" });
    if (res.ok) setMeta(await res.json());
  }, []);
  useEffect(() => { void load(mode); }, [load, mode]);
  useRoomEvent(() => { void load(mode); });

  // change leverage
  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const [levAcct, setLevAcct] = useState("");
  const [levNew, setLevNew] = useState(0);
  const [levMsg, setLevMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [levBusy, setLevBusy] = useState(false);
  const levRow = meta?.leverage.find((l) => l.accountId === (levAcct || accounts[0]?.id));
  useEffect(() => { if (!levAcct && accounts[0]) setLevAcct(accounts[0].id); }, [accounts, levAcct]);
  useEffect(() => { if (levRow) setLevNew(levRow.options.find((o) => o !== levRow.current) ?? levRow.current); }, [levRow?.accountId, levRow?.current]); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyLeverage() {
    if (!levRow || levBusy) return;
    setLevBusy(true);
    setLevMsg(null);
    const res = await fetch("/api/room/leverage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: levRow.accountId, leverage: levNew }) });
    const body = await res.json().catch(() => null);
    setLevBusy(false);
    if (!res.ok) { setLevMsg({ ok: false, text: body?.error ?? "Could not change leverage." }); return; }
    setLevMsg({ ok: true, text: body.status === "pending" ? `Request sent: 1:${levNew}. Pending broker approval.` : `Leverage is now 1:${levNew}.` });
    await Promise.all([refresh(), load(mode)]);
  }

  // open account
  const [planId, setPlanId] = useState("");
  const plan = useMemo(() => meta?.plans.find((p) => p.groupId === planId) ?? meta?.plans[0] ?? null, [meta, planId]);
  const [lev, setLev] = useState(0);
  useEffect(() => { if (plan) setLev(plan.leverageOptions[0]); }, [plan]);
  const [currency, setCurrency] = useState("");
  const [openMsg, setOpenMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [openBusy, setOpenBusy] = useState(false);
  async function createAccount() {
    if (!plan || openBusy) return;
    setOpenBusy(true);
    setOpenMsg(null);
    const res = await fetch("/api/room/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, groupId: plan.groupId, leverage: lev, currency: currency || meta?.currencies[0] }) });
    const body = await res.json().catch(() => null);
    setOpenBusy(false);
    if (!res.ok) { setOpenMsg({ ok: false, text: body?.error ?? "Could not open the account." }); return; }
    setOpenMsg({ ok: true, text: body.status === "created" ? `Demo account ${body.accountNumber} is ready. Sign in with your portal password.` : "Request sent. Your broker opens the account after review." });
    await Promise.all([refresh(), load(mode)]);
  }
  const liveBlocked = mode === "LIVE" && meta ? (!meta.kycApproved ? "Complete KYC before opening a live account." : meta.liveRequest ? "Your live account request is with your broker." : "") : "";

  return (
    <>
      <RoomHeader title="Accounts" />
      <div className="r-body">
        <div className="r-card r-pad">
          <div className="r-label" style={{ marginBottom: 14 }}>My accounts</div>
          <div className="r-table-wrap">
            <table className="r-table" style={{ fontSize: 13 }}>
              <thead><tr>{[th("ACCOUNT"), th("MODE"), th("PLAN"), th("LEVERAGE"), th(`BALANCE ${accounts[0]?.currency ?? "USD"}`, true), th(`EQUITY ${accounts[0]?.currency ?? "USD"}`, true), th("OPENED"), th("")]}</tr></thead>
              <tbody className="mono" style={{ fontSize: 12.5 }}>
                {accounts.map((a) => {
                  const pending = meta?.leverage.find((l) => l.accountId === a.id)?.pending;
                  return (
                    <tr key={a.id}>
                      <td style={{ ...td, fontWeight: 600 }}>{a.accountNumber}</td>
                      <td style={td}><span className={`r-mode ${a.mode === "LIVE" ? "r-mode-live" : ""}`} style={{ fontFamily: "var(--r-sans)", fontSize: 11, color: a.mode === "LIVE" ? undefined : "var(--r-muted)" }}><span className="r-dot" style={{ width: 5, height: 5 }} />{a.mode}</span></td>
                      <td style={{ ...td, fontFamily: "var(--r-sans)" }}>{a.plan}</td>
                      <td style={td}>1:{a.leverage}{pending ? <span className="r-chip-pending" style={{ fontFamily: "var(--r-sans)", fontSize: 11, marginLeft: 8 }}>1:{pending.to} pending</span> : null}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(a.figures.balance)}</td>
                      <td style={{ ...td, textAlign: "right" }}>{money(a.figures.equity)}</td>
                      <td style={{ ...td, color: "var(--r-text-2)" }}>{day(a.openedAt)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "var(--r-sans)", fontSize: 12.5 }}>
                        {a.mode === "LIVE" ? (
                          <><a href={`/room/deposit?account=${a.id}`} style={{ fontWeight: 500 }}>Deposit</a><span style={{ color: "var(--r-faint)", margin: "0 8px" }}>·</span><button type="button" onClick={() => { setLevAcct(a.id); document.getElementById("lev-panel")?.scrollIntoView({ behavior: "smooth" }); }} style={{ background: "none", border: "none", padding: 0, color: "var(--r-gold-text)", font: "inherit", fontWeight: 500, cursor: "pointer" }}>Leverage</button></>
                        ) : <a href="/room/downloads" style={{ fontWeight: 500 }}>Trade</a>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data && accounts.length === 0 ? <div className="r-empty">No accounts yet. Open one below.</div> : null}
          </div>
        </div>

        <div id="lev-panel" className="r-card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 17, fontWeight: 600 }}>Change leverage</div>
            <div style={{ fontSize: 12.5, color: "var(--r-muted)", marginTop: 5 }}>Margin on open positions recalculates on the new leverage right away.</div>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="r-field">
              <label htmlFor="lacct">Account</label>
              <select id="lacct" className="r-input mono" style={{ fontSize: 13, padding: "10px 12px", minWidth: 260 }} value={levAcct} onChange={(e) => { setLevAcct(e.target.value); setLevMsg(null); }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{`${a.accountNumber} · ${a.mode === "DEMO" ? "Demo" : a.plan} · current 1:${a.leverage}`}</option>)}
              </select>
            </div>
            <div className="r-field">
              <label htmlFor="lnew">New leverage</label>
              <select id="lnew" className="r-input mono" style={{ fontSize: 13, padding: "10px 12px", minWidth: 140 }} value={levNew} onChange={(e) => setLevNew(Number(e.target.value))}>
                {(levRow?.options ?? []).map((o) => <option key={o} value={o} disabled={o === levRow?.current}>1:{o}</option>)}
              </select>
            </div>
            <button type="button" className="r-btn" style={{ padding: "11px 24px" }} disabled={!levRow || levBusy || levNew === levRow?.current || Boolean(levRow?.pending)} onClick={applyLeverage}>{levBusy ? "Applying…" : "Apply"}</button>
          </div>
          {levRow?.pending ? <div className="r-chip-pending" style={{ fontSize: 12.5 }}>1:{levRow.pending.to} is pending broker approval.</div> : null}
          {levMsg ? <div className={levMsg.ok ? "r-okmsg" : "r-error"} role="status">{levMsg.text}</div> : null}
          <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>If your broker reviews leverage changes, the request stays pending until approved. The available ceiling depends on your plan and tier.</div>
        </div>

        <div id="open" className="r-card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 17, fontWeight: 600 }}>Open a new account</div>
            <div style={{ fontSize: 12.5, color: "var(--r-muted)", marginTop: 5 }}>Pick a plan. Conditions apply from the first trade.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <div className="r-flabel">Mode</div>
            <div role="group" aria-label="Mode" style={{ display: "inline-flex", background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 7, padding: 3 }}>
              {(["LIVE", "DEMO"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setPlanId(""); setOpenMsg(null); }}
                  style={{ background: mode === m ? "var(--r-accent)" : "none", color: mode === m ? "var(--r-on-accent)" : "var(--r-text-2)", border: "none", borderRadius: 5, fontSize: 12.5, fontWeight: mode === m ? 600 : 500, padding: "7px 20px", cursor: "pointer" }}>
                  {m === "LIVE" ? "Live" : "Demo"}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 340px))", gap: 14 }}>
            {(meta?.plans ?? []).map((p) => {
              const sel = plan?.groupId === p.groupId;
              return (
                <div key={p.groupId} style={{ border: sel ? "1.5px solid var(--r-accent)" : "1px solid var(--r-input)", borderRadius: 10, padding: 20, background: sel ? "var(--r-gold-tint)" : "var(--r-card-2)", display: "flex", flexDirection: "column", gap: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontFamily: "var(--r-head)", fontSize: 15.5, fontWeight: 600 }}>{p.name}</span>
                    {sel ? <span style={{ fontSize: 10, letterSpacing: 1, fontWeight: 700, color: "var(--r-gold-text)" }}>SELECTED</span> : null}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 12.5, color: "var(--r-text-2)" }}>
                    {p.spreadFrom ? <div style={{ display: "flex", justifyContent: "space-between" }}><span>Spread from</span><span className="mono" style={{ color: "var(--r-text)" }}>{p.spreadFrom}</span></div> : null}
                    {p.commissionPerLot ? <div style={{ display: "flex", justifyContent: "space-between" }}><span>Commission</span><span className="mono" style={{ color: "var(--r-text)" }}>{money(p.commissionPerLot)} / lot</span></div> : null}
                    {p.minDeposit && mode === "LIVE" ? <div style={{ display: "flex", justifyContent: "space-between" }}><span>Min deposit</span><span className="mono" style={{ color: "var(--r-text)" }}>{Number(p.minDeposit).toLocaleString("en-US")} {meta?.currencies[0]}</span></div> : null}
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>Max leverage</span><span className="mono" style={{ color: "var(--r-text)" }}>1:{p.maxLeverage}</span></div>
                  </div>
                  <button type="button" className={sel ? "r-btn r-btn-sm" : "r-btn-ghost r-btn-sm"} style={{ padding: "9px 0" }} onClick={() => { setPlanId(p.groupId); setOpenMsg(null); }}>{sel ? "Selected" : "Select"}</button>
                </div>
              );
            })}
          </div>
          {meta && meta.plans.length === 0 ? <div className="r-note">No plans are open for {mode === "LIVE" ? "live" : "demo"} accounts right now.</div> : null}
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div className="r-field">
              <label htmlFor="lev">Leverage</label>
              <select id="lev" className="r-input mono" style={{ fontSize: 13, padding: "10px 12px", minWidth: 140 }} value={lev} onChange={(e) => setLev(Number(e.target.value))}>
                {(plan?.leverageOptions ?? []).map((o) => <option key={o} value={o}>1:{o}</option>)}
              </select>
            </div>
            <div className="r-field">
              <label htmlFor="cur">Currency</label>
              <select id="cur" className="r-input mono" style={{ fontSize: 13, padding: "10px 12px", minWidth: 140 }} value={currency || meta?.currencies[0] || ""} onChange={(e) => setCurrency(e.target.value)}>
                {(meta?.currencies ?? []).map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <button type="button" className="r-btn" style={{ padding: "11px 24px", marginLeft: "auto" }} disabled={!plan || openBusy || Boolean(liveBlocked)} onClick={createAccount}>{openBusy ? "Creating…" : "Create account"}</button>
          </div>
          {liveBlocked ? <div className="r-note">{liveBlocked}{!meta?.kycApproved ? <> <a href="/room/verify">Verify now</a></> : null}</div> : null}
          {openMsg ? <div className={openMsg.ok ? "r-okmsg" : "r-error"} role="status">{openMsg.text}</div> : null}
        </div>
      </div>
    </>
  );
}
