"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoomEvent } from "@/components/room/RoomData";

// Artboard "My tier & volume": current tier, progress to the next, volume, the broker's tier table (GET /api/room/tier).
type Tier = { name: string; minLots: number; benefits: string[]; maxLeverage: number | null };
type Data = {
  tiers: Tier[]; current: string; since: string; nextReview: string;
  next: { name: string; minLots: number; missing: string } | null;
  lots90: string; lotsMonth: string; lotsAll: string; perAccount: { accountNumber: string; lots: string }[]; maxLeverage: number | null;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (iso: string) => { const d = new Date(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayMonYear = (iso: string) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const n1 = (s: string) => Number(s).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const Tick = () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--r-accent)" strokeWidth="1.8" aria-hidden="true" style={{ marginTop: 3, flexShrink: 0 }}><path d="m2.5 7.5 3 3 6-6" /></svg>;

export default function RoomTier() {
  const [d, setD] = useState<Data | null>(null);
  const [tick, setTick] = useState(0);
  useRoomEvent(() => setTick((t) => t + 1));
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/room/tier", { cache: "no-store" });
      if (res.ok && live) setD(await res.json());
    })();
    return () => { live = false; };
  }, [tick]);

  const pct = d?.next ? Math.min(100, (Number(d.lots90) / d.next.minLots) * 100) : 100;
  const sub = <span style={{ fontSize: 12.5, color: "var(--r-muted)" }}>Reviewed monthly on 90-day traded volume</span>;
  return (
    <>
      <RoomHeader title="My tier" right={sub} picker={false} />
      <div className="r-body" style={{ gap: 22 }}>
        <div style={{ background: "var(--r-gold-tint)", border: "1px solid color-mix(in srgb, var(--r-accent) 35%, transparent)", borderRadius: 10, padding: 24, display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center" }}>
          <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
            <circle cx="27" cy="21" r="12" fill="none" stroke="var(--r-accent)" strokeWidth="2" />
            <path d="M27 12.5 29.6 17.8 35.4 18.6 31.2 22.7 32.2 28.4 27 25.7 21.8 28.4 22.8 22.7 18.6 18.6 24.4 17.8Z" fill="var(--r-accent)" />
            <path d="m19.5 31-4.5 15L27 41l12 5-4.5-15" fill="none" stroke="var(--r-accent)" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10.5, letterSpacing: 1.4, color: "var(--r-pending)", fontWeight: 700 }}>CURRENT TIER</div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 28, fontWeight: 700, color: "var(--r-gold-text)", letterSpacing: 2, marginTop: 4 }}>{d ? d.current.toUpperCase() : " "}</div>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 6 }}>{d ? `${d.current} since ${monthYear(d.since)} · next review ${dayMonYear(d.nextReview)}` : " "}</div>
          </div>
          <div style={{ flex: "1 1 320px", minWidth: 260 }}>
            {d?.next ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--r-text-2)", marginBottom: 8, gap: 10 }}>
                  <span>Progress to <span style={{ color: "var(--r-text)", fontWeight: 600 }}>{d.next.name}</span></span>
                  <span className="mono">{n1(d.lots90)} / {d.next.minLots.toLocaleString("en-US")} lots · 90d</span>
                </div>
                <div role="progressbar" aria-valuemin={0} aria-valuemax={d.next.minLots} aria-valuenow={Number(d.lots90)} aria-label={`Progress to ${d.next.name}`} style={{ height: 10, background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 5, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: "var(--r-accent)", borderRadius: 5 }} />
                </div>
                <div style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 8 }}>
                  {Number(d.next.missing) > 0 ? `${n1(d.next.missing)} more lots in the next 90 days keeps you on track for ${d.next.name}.` : `Your volume reaches ${d.next.name}. It applies at the next review.`}
                </div>
              </>
            ) : d ? <div style={{ fontSize: 12.5, color: "var(--r-text-2)" }}>You are on the top tier.</div> : null}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
          {([["Volume · 90 days", d?.lots90], ["Volume · this month", d?.lotsMonth], ["Volume · all time", d?.lotsAll]] as const).map(([k, v]) => (
            <div key={k} className="r-card r-tile">
              <div className="r-label" style={{ letterSpacing: 1.2 }}>{k}</div>
              <div className="r-tile-v">{v != null ? n1(v) : "0.0"} <span style={{ fontSize: 12, color: "var(--r-muted)", fontWeight: 400 }}>lots</span></div>
            </div>
          ))}
          <div className="r-card r-tile">
            <div className="r-label" style={{ letterSpacing: 1.2 }}>By account · 90d</div>
            <div className="mono" style={{ fontSize: 12.5, marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
              {(d?.perAccount ?? []).map((a) => (
                <div key={a.accountNumber} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}><span style={{ color: "var(--r-muted)" }}>{a.accountNumber}</span><span>{n1(a.lots)}</span></div>
              ))}
              {d && d.perAccount.length === 0 ? <span style={{ color: "var(--r-muted)", fontFamily: "var(--r-sans)" }}>No live accounts yet.</span> : null}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
          {(d?.tiers ?? []).map((t) => {
            const mine = t.name === d?.current;
            const lines = [...t.benefits, ...(t.maxLeverage ? [`Leverage up to 1:${t.maxLeverage}`] : [])];
            return (
              <div key={t.name} style={{ border: mine ? "1.5px solid var(--r-accent)" : "1px solid var(--r-input)", borderRadius: 10, padding: 22, background: mine ? "var(--r-gold-tint)" : "var(--r-card-2)", display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--r-head)", fontSize: 16, fontWeight: mine ? 700 : 600, letterSpacing: 1, color: mine ? "var(--r-gold-text)" : "var(--r-text-2)" }}>{t.name.toUpperCase()}</span>
                  {mine ? <span style={{ fontSize: 10, letterSpacing: 1, fontWeight: 700, color: "var(--r-gold-text)" }}>YOUR TIER</span> : <span className="mono" style={{ fontSize: 11, color: "var(--r-muted)" }}>{t.minLots.toLocaleString("en-US")}+ lots · 90d</span>}
                </div>
                {mine ? <div className="mono" style={{ fontSize: 11, color: "var(--r-muted)", marginTop: -6 }}>{t.minLots.toLocaleString("en-US")}+ lots · 90d</div> : null}
                {lines.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 12.5, color: mine ? "var(--r-text)" : "var(--r-text-2)" }}>
                    {lines.map((b) => <div key={b} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}><Tick />{b}</div>)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>Tier thresholds and benefits are set by your broker and may change with notice.</div>
      </div>
    </>
  );
}
