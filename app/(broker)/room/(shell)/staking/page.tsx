"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money, day } from "@/components/room/format";

// Staking: the broker's plan, a new stake, active stakes with a countdown, and history. Every figure comes from the server
// except the preview of the return for the amount being typed.
type Stake = { id: string; account: string; amount: string; currency: string; ratePct: string; cycleDays: number; returnAmount: string; startAt: string; endAt: string; paidAt: string | null; status: string };
type Data = { verified: boolean; plan: { minAmount: string; cycleDays: number; ratePct: string }; accounts: { id: string; accountNumber: string; currency: string; free: string }[]; active: Stake[]; history: Stake[] };

function left(iso: string, now: number) {
  const ms = Math.max(0, new Date(iso).getTime() - now);
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function RoomStaking() {
  const { refresh } = useRoom();
  const [d, setD] = useState<Data | null>(null);
  const [off, setOff] = useState(false);
  const [tick, setTick] = useState(0);
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useRoomEvent(() => setTick((t) => t + 1));
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/room/staking", { cache: "no-store" });
      if (res.status === 404) { if (live) setOff(true); return; }
      if (res.ok && live) setD(await res.json());
    })();
    return () => { live = false; };
  }, [tick]);

  const account = d?.accounts.find((a) => a.id === accountId) ?? d?.accounts[0] ?? null;
  const ccy = account?.currency ?? "USD";
  const value = Number(amount);
  const entered = Number.isFinite(value) && value > 0;
  const expected = d && entered ? Math.floor(value * Number(d.plan.ratePct)) / 100 : 0;
  const unlock = d ? new Date(now + d.plan.cycleDays * 86400e3).toISOString() : "";
  const tooLow = d && entered && value < Number(d.plan.minAmount);
  const tooHigh = account && entered && value > Number(account.free);

  async function confirm() {
    if (!account || busy) return;
    setBusy(true); setMsg(null);
    const res = await fetch("/api/room/staking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: account.id, amount }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Could not stake." }); return; }
    setAmount(""); setMsg({ ok: true, text: "Stake confirmed." });
    setTick((t) => t + 1);
    await refresh();
  }

  const row = { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, color: "var(--r-text-2)" } as const;
  const mono = { color: "var(--r-text)" } as const;
  const list = (rows: Stake[], active: boolean) => (
    <div className="r-table-wrap">
      <table className="r-table">
        <thead><tr><th>ACCOUNT</th><th>AMOUNT</th><th>RETURN</th><th>RATE</th><th>START</th><th>END</th><th>{active ? "UNLOCKS IN" : "PAID"}</th></tr></thead>
        <tbody className="mono">
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.account}</td><td>{money(s.amount)} {s.currency}</td><td>{money(s.returnAmount)}</td><td>{s.ratePct}%</td><td>{day(s.startAt)}</td><td>{day(s.endAt)}</td>
              <td>{active ? left(s.endAt, now) : s.paidAt ? day(s.paidAt) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <RoomHeader title="Staking" />
      <div className="r-body" style={{ gap: 20 }}>
        {off ? <div className="r-card r-pad r-note">Staking is not available.</div> : null}
        {d && !d.verified ? (
          <div className="r-card r-pad" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Available after verification</div>
            <a className="r-btn r-btn-sm" href="/room/verify">Verify</a>
          </div>
        ) : null}
        {d?.verified ? (
          <div className="r-row">
            <div className="r-card r-pad" style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="r-label">Plan</div>
              <div style={row}><span>Rate per cycle</span><span className="mono" style={mono}>{d.plan.ratePct}%</span></div>
              <div style={row}><span>Cycle</span><span className="mono" style={mono}>{d.plan.cycleDays} days</span></div>
              <div style={row}><span>Minimum</span><span className="mono" style={mono}>{money(d.plan.minAmount)} {ccy}</span></div>
              <div style={{ fontSize: 11.5, color: "var(--r-muted)", lineHeight: 1.6 }}>Rate set by your broker, may change for new stakes</div>
            </div>
            <div className="r-card" style={{ flex: "2 1 420px", minWidth: 0, padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
              {d.accounts.length === 0 ? <div className="r-note">Open a live account to stake. <a href="/room/accounts#open">Open an account</a></div> : (
                <>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <div className="r-field" style={{ flex: "1 1 200px" }}>
                      <label htmlFor="sacct">Account</label>
                      <select id="sacct" className="r-input mono" style={{ fontSize: 13 }} value={account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)}>
                        {d.accounts.map((a) => <option key={a.id} value={a.id}>{`${a.accountNumber} · free ${money(a.free)} ${a.currency}`}</option>)}
                      </select>
                    </div>
                    <div className="r-field" style={{ flex: "1 1 200px" }}>
                      <label htmlFor="samt">Amount · {ccy}</label>
                      <input id="samt" className="r-input mono" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => { setAmount(e.target.value); setMsg(null); }} />
                    </div>
                  </div>
                  {entered ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={row}><span>Expected return</span><span className="mono" style={mono}>{money(expected.toFixed(2))} {ccy}</span></div>
                      <div style={row}><span>Unlock date</span><span className="mono" style={mono}>{day(unlock)}</span></div>
                    </div>
                  ) : null}
                  {tooLow ? <div className="r-error">The minimum is {money(d.plan.minAmount)} {ccy}.</div> : null}
                  {tooHigh ? <div className="r-error">This is more than the account&apos;s free margin.</div> : null}
                  {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
                  <button type="button" className="r-btn" style={{ alignSelf: "flex-start", padding: "11px 24px" }} disabled={busy || !entered || Boolean(tooLow) || Boolean(tooHigh)} onClick={confirm}>{busy ? "Confirming…" : "Confirm stake"}</button>
                </>
              )}
            </div>
          </div>
        ) : null}
        {d && d.active.length ? <div className="r-card r-pad"><div className="r-label" style={{ marginBottom: 10 }}>Active stakes</div>{list(d.active, true)}</div> : null}
        {d && d.history.length ? <div className="r-card r-pad"><div className="r-label" style={{ marginBottom: 10 }}>History</div>{list(d.history, false)}</div> : null}
      </div>
    </>
  );
}
