"use client";

import { useEffect, useRef, useState } from "react";
import { useRoomEvent } from "@/components/room/RoomData";

// The Dashboard's tier strip: the active tier and the progress to the next (GET /api/room/tier). Pressing it opens every
// tier with its threshold and benefits, the client's own marked.
type Tier = { name: string; minLots: number; benefits: string[]; maxLeverage: number | null };
type Data = {
  tiers: Tier[]; current: string; since: string; nextReview: string;
  next: { name: string; minLots: number; missing: string } | null;
  lots90: string; lotsMonth: string; lotsAll: string; hasLiveAccount: boolean;
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthYear = (iso: string) => { const d = new Date(iso); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dayMonYear = (iso: string) => { const d = new Date(iso); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const n1 = (s: string) => Number(s).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const Tick = () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--r-accent)" strokeWidth="1.8" aria-hidden="true" style={{ marginTop: 3, flexShrink: 0 }}><path d="m2.5 7.5 3 3 6-6" /></svg>;
const Medal = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 54 54" aria-hidden="true" style={{ flexShrink: 0 }}>
    <circle cx="27" cy="21" r="12" fill="none" stroke="var(--r-accent)" strokeWidth="2" />
    <path d="M27 12.5 29.6 17.8 35.4 18.6 31.2 22.7 32.2 28.4 27 25.7 21.8 28.4 22.8 22.7 18.6 18.6 24.4 17.8Z" fill="var(--r-accent)" />
    <path d="m19.5 31-4.5 15L27 41l12 5-4.5-15" fill="none" stroke="var(--r-accent)" strokeWidth="2" strokeLinejoin="round" />
  </svg>
);

function TierList({ d, onClose }: { d: Data; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="r-modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="r-modal" role="dialog" aria-modal="true" aria-label="Tiers">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 19, fontWeight: 600 }}>Tiers</div>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 4 }}>{d.current} since {monthYear(d.since)} · next review {dayMonYear(d.nextReview)}</div>
          </div>
          <button ref={close} type="button" className="r-icon-btn" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" /></svg>
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
          {d.tiers.map((t) => {
            const mine = t.name === d.current;
            const lines = [...t.benefits, ...(t.maxLeverage ? [`Leverage up to 1:${t.maxLeverage}`] : [])];
            return (
              <div key={t.name} style={{ border: mine ? "1.5px solid var(--r-accent)" : "1px solid var(--r-input)", borderRadius: 10, padding: 18, background: mine ? "var(--r-gold-tint)" : "var(--r-card-2)", display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "var(--r-head)", fontSize: 15, fontWeight: mine ? 700 : 600, letterSpacing: 1, color: mine ? "var(--r-gold-text)" : "var(--r-text-2)" }}>{t.name.toUpperCase()}</span>
                  {mine ? <span style={{ fontSize: 10, letterSpacing: 1, fontWeight: 700, color: "var(--r-gold-text)" }}>YOUR TIER</span> : null}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--r-muted)" }}>{t.minLots.toLocaleString("en-US")}+ lots · 90d</div>
                {lines.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5, color: mine ? "var(--r-text)" : "var(--r-text-2)" }}>
                    {lines.map((b) => <div key={b} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}><Tick />{b}</div>)}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)" }}>{n1(d.lots90)} lots · 90 days / {n1(d.lotsMonth)} this month / {n1(d.lotsAll)} all time</div>
        <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>{d.hasLiveAccount ? "" : "Tier volume counts live accounts. "}Reviewed monthly on 90-day traded volume. Thresholds and benefits are set by your broker and may change with notice.</div>
      </div>
    </div>
  );
}

export default function TierPanel() {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
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

  if (!d) return <div id="tier" className="r-tier-strip" style={{ minHeight: 58 }} />;
  const pct = d.next ? Math.min(100, (Number(d.lots90) / d.next.minLots) * 100) : 100;
  return (
    <>
      <button id="tier" type="button" className="r-tier-strip" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Medal size={30} />
        <span style={{ fontFamily: "var(--r-head)", fontSize: 15, fontWeight: 700, letterSpacing: 1.5, color: "var(--r-gold-text)" }}>{d.current.toUpperCase()}</span>
        <span style={{ flex: "1 1 240px", minWidth: 0 }}>
          {d.next ? (
            <>
              <span style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "2px 10px", fontSize: 11.5, color: "var(--r-text-2)", marginBottom: 6 }}>
                <span>Progress to <span style={{ color: "var(--r-text)", fontWeight: 600 }}>{d.next.name}</span></span>
                {d.hasLiveAccount ? <span className="mono">{n1(d.lots90)} / {d.next.minLots.toLocaleString("en-US")} lots · 90d</span> : <span>Tier volume counts live accounts</span>}
              </span>
              <span role="progressbar" aria-valuemin={0} aria-valuemax={d.next.minLots} aria-valuenow={Number(d.lots90)} aria-label={`Progress to ${d.next.name}`} style={{ display: "block", height: 6, background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 3, overflow: "hidden" }}>
                <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "var(--r-accent)" }} />
              </span>
            </>
          ) : <span style={{ fontSize: 12.5, color: "var(--r-text-2)" }}>You are on the top tier.</span>}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--r-gold-text)", whiteSpace: "nowrap" }}>All tiers</span>
      </button>
      {open ? <TierList d={d} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
