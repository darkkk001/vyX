"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money, day } from "@/components/room/format";

// Artboard "Partner (IB) portal": referral link + QR, stats, the month's commission per masked client, the broker's
// per-plan rates, payouts and a payout request (GET / POST /api/room/partner).
type Data = {
  partnerAccount: string; suspended: boolean; code: string; link: string; qr: string;
  stats: { clients: number; activeThisMonth: number; lots: string; earned: string; unpaid: string };
  month: string;
  perClient: { client: string; joined: string; lots: string; commission: string }[];
  rates: { plan: string; perLot: string }[];
  payouts: { ref: string; at: string; amount: string; status: string }[];
  pendingRequest: { amount: string; at: string } | null;
};
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export default function RoomPartner() {
  const brand = useRoom().data?.platform?.name ?? null; // the tenant speaks (owner 2026-11-10)
  const [d, setD] = useState<Data | null>(null);
  const [missing, setMissing] = useState(false);
  const [month, setMonth] = useState(ym(new Date()));
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  useRoomEvent(() => setTick((t) => t + 1));
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/room/partner?month=${month}`, { cache: "no-store" });
      if (res.status === 404) { if (live) setMissing(true); return; }
      if (res.ok && live) setD(await res.json());
    })();
    return () => { live = false; };
  }, [month, tick]);

  async function requestPayout() {
    setMsg(null);
    const res = await fetch("/api/room/partner", { method: "POST" });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setMsg({ ok: false, text: body?.error ?? "Could not send the request." }); return; }
    setMsg({ ok: true, text: `Payout of ${money(body.amount)} requested.` });
    setTick((t) => t + 1);
  }

  const months = Array.from({ length: 6 }, (_, i) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - i, 1)); });
  const right = d ? (
    <>
      <span style={{ fontSize: 10.5, letterSpacing: 1, fontWeight: 700, color: d.suspended ? "var(--r-pending)" : "var(--r-ok)", border: "1px solid currentColor", borderRadius: 5, padding: "3px 8px" }}>IB · {d.suspended ? "ON HOLD" : "ACTIVE"}</span>
      <button type="button" className="r-btn r-btn-sm" disabled={d.suspended || Boolean(d.pendingRequest) || Number(d.stats.unpaid) <= 0} onClick={requestPayout}>{d.pendingRequest ? "Payout requested" : "Request payout"}</button>
    </>
  ) : null;
  if (missing) {
    return (
      <>
        <RoomHeader title="Partner portal" picker={false} />
        <div className="r-body"><div className="r-card r-pad r-note">The partner portal opens once your partner account is set up.</div></div>
      </>
    );
  }
  const monthDate = d ? new Date(d.month) : new Date();
  return (
    <>
      <RoomHeader title="Partner portal" right={right} picker={false} />
      <div className="r-body" style={{ gap: 22 }}>
        {msg ? <div className={msg.ok ? "r-okmsg" : "r-error"} role="status">{msg.text}</div> : null}
        <div className="r-card" style={{ padding: 18, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="r-label" style={{ marginBottom: 7 }}>Your referral link</div>
            <div className="mono" style={{ fontSize: 13.5, color: "var(--r-gold-text)", overflowWrap: "anywhere" }}>{d?.link ?? " "}</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" className="r-btn-ghost r-btn-sm" disabled={!d} onClick={() => { if (d) void navigator.clipboard?.writeText(d.link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}>{copied ? "Copied" : "Copy link"}</button>
            <button type="button" className="r-btn-ghost r-btn-sm" disabled={!d} aria-expanded={showQr} onClick={() => setShowQr((v) => !v)}>QR code</button>
          </div>
          {showQr && d ? (
            <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 16, borderTop: "1px solid var(--r-line)", paddingTop: 14 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={d.qr} alt={`QR code for ${d.link}`} width={140} height={140} style={{ background: "#fff", borderRadius: 6, padding: 4 }} />
              <a href={d.qr} download={`referral-${d.code}.png`} style={{ fontSize: 12.5, fontWeight: 500 }}>Download QR code</a>
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
          {([["Clients", d ? String(d.stats.clients) : "0", ""], ["Active this month", d ? String(d.stats.activeThisMonth) : "0", ""], ["Volume · lots", d ? Number(d.stats.lots).toLocaleString("en-US", { minimumFractionDigits: 1 }) : "0.0", ""], ["Earned · USD", money(d?.stats.earned ?? 0), ""], ["Unpaid · USD", money(d?.stats.unpaid ?? 0), "var(--r-gold-text)"]] as const).map(([k, v, c]) => (
            <div key={k} className="r-card r-tile">
              <div className="r-label" style={{ letterSpacing: 1.2 }}>{k}</div>
              <div className="r-tile-v" style={{ color: c || undefined }}>{v}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <div className="r-card r-pad" style={{ flex: "2 1 480px", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <div className="r-label">Commission · {MONTHS[monthDate.getUTCMonth()]} {monthDate.getUTCFullYear()}</div>
              <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ background: "var(--r-card)", border: "1px solid var(--r-input)", borderRadius: 6, color: "var(--r-text)", fontSize: 12, padding: "5px 8px" }}>
                {months.map((m) => <option key={ym(m)} value={ym(m)}>{`${MON[m.getUTCMonth()]} ${m.getUTCFullYear()}`}</option>)}
              </select>
            </div>
            <div className="r-table-wrap">
              <table className="r-table" style={{ fontSize: 13 }}>
                <thead><tr>
                  {(["CLIENT", "JOINED", "VOLUME LOTS", "COMMISSION USD"] as const).map((h, i) => <th key={h} style={{ padding: "8px 10px", fontSize: 10.5, borderBottom: "1px solid var(--r-border)", textAlign: i >= 2 ? "right" : "left" }}>{h}</th>)}
                </tr></thead>
                <tbody className="mono" style={{ fontSize: 12.5 }}>
                  {(d?.perClient ?? []).map((c, i) => (
                    <tr key={`${c.client}-${i}`}>
                      <td style={{ padding: "11px 10px" }}>{c.client}</td>
                      <td style={{ padding: "11px 10px", color: "var(--r-text-2)" }}>{`${MON[new Date(c.joined).getMonth()]} ${new Date(c.joined).getFullYear()}`}</td>
                      <td style={{ padding: "11px 10px", textAlign: "right" }}>{c.lots}</td>
                      <td style={{ padding: "11px 10px", textAlign: "right" }}>{money(c.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {d && d.perClient.length === 0 ? <div className="r-empty">No commission in this month yet.</div> : null}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--r-faint)", marginTop: 12 }}>Client identities are masked. Commission accrues per closed lot and is paid to your account {d?.partnerAccount ?? ""}.</div>
          </div>

          <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="r-card r-pad">
              <div className="r-label" style={{ marginBottom: 14 }}>Your rates</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12.5, color: "var(--r-text-2)" }}>
                {(d?.rates ?? []).map((r) => (
                  <div key={r.plan} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span>{r.plan} accounts</span><span className="mono" style={{ color: "var(--r-text)" }}>{money(r.perLot)} / lot</span></div>
                ))}
                {d && d.rates.length === 0 ? <span>{brand ? `${brand} sets the rate for each plan.` : "The rate is set for each plan."}</span> : null}
              </div>
            </div>
            <div className="r-card r-pad">
              <div className="r-label" style={{ marginBottom: 14 }}>Payouts</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
                {d?.pendingRequest ? (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <div><div>Requested</div><div style={{ color: "var(--r-muted)", fontSize: 11.5, marginTop: 3 }}>{day(d.pendingRequest.at)}</div></div>
                    <div style={{ textAlign: "right" }}><div className="mono">{money(d.pendingRequest.amount)}</div><div style={{ color: "var(--r-pending)", fontSize: 11, fontWeight: 600, marginTop: 3 }}>Pending</div></div>
                  </div>
                ) : null}
                {(d?.payouts ?? []).map((p, i) => (
                  <div key={p.ref} style={{ display: "flex", justifyContent: "space-between", gap: 10, borderTop: i || d?.pendingRequest ? "1px solid var(--r-row)" : "none", paddingTop: i || d?.pendingRequest ? 12 : 0 }}>
                    <div><div className="mono">{p.ref}</div><div style={{ color: "var(--r-muted)", fontSize: 11.5, marginTop: 3 }}>{day(p.at)}</div></div>
                    <div style={{ textAlign: "right" }}><div className="mono">{money(p.amount)}</div><div style={{ color: "var(--r-ok)", fontSize: 11, fontWeight: 600, marginTop: 3 }}>{p.status}</div></div>
                  </div>
                ))}
                {d && d.payouts.length === 0 && !d.pendingRequest ? <span style={{ color: "var(--r-muted)" }}>No payouts yet.</span> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
