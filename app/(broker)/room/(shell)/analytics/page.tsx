"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money, pnlClass } from "@/components/room/format";

// Artboard "Analytics": every figure comes from GET /api/room/analytics (computed on the server from the closed trades
// and the ledger); this page only draws them.
type Bar = { name: string; net: string };
type TradeRow = { id: string; closedAt: string; symbol: string; side: "BUY" | "SELL"; lots: string; r: string | null; net: string };
type Data = {
  tiles: { net: string; winRate: string; profitFactor: string | null; trades: number; lots: string; avgWin: string; avgLoss: string };
  curve: { day: string; equity: string }[];
  curveLow: { equity: string; day: string } | null;
  curveHigh: { equity: string; day: string } | null;
  bySession: Bar[]; sessionCaption: string;
  byDayOfWeek: Bar[]; dayCaption: string;
  bySymbol: Bar[]; symCaption: string;
  risk: { avgRiskPct: string | null; avgWinR: string | null; maxDrawdownPct: string | null; longestWin: number; longestLoss: number; avgHoldMinutes: number; withoutSl: number; largestLoss: string };
  riskCaption: string;
  best: TradeRow[]; worst: TradeRow[];
  perAccount: { id: string; accountNumber: string; plan: string; net: string; lots: string; trades: number }[];
  currency: string;
};
const PERIOD_LABEL: Record<string, string> = { "90d": "LAST 90 DAYS", "30d": "LAST 30 DAYS", ytd: "THIS YEAR", all: "ALL TIME" };
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const shortDay = (iso: string) => { const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso); return `${String(d.getUTCDate()).padStart(2, "0")} ${MON[d.getUTCMonth()]}`; };
const monDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`; };
const hold = (m: number) => (m >= 60 * 24 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const sel = { background: "var(--r-card)", border: "1px solid var(--r-input)", borderRadius: 6, color: "var(--r-text)", fontSize: 12.5, padding: "8px 10px" } as const;
const card = { padding: 18 } as const;

function Bars({ bars, label }: { bars: Bar[]; label: string }) {
  // one scale for both directions: the zero line sits where the largest gain and the largest loss share the height
  const W = 480, top = 24, area = 128;
  const vals = bars.map((b) => Number(b.net));
  const posMax = Math.max(0, ...vals), negMax = Math.max(0, ...vals.map((v) => -v));
  const total = posMax + negMax || 1;
  const zero = top + (area * posMax) / total;
  const slot = (W - 20) / Math.max(1, bars.length);
  return (
    <svg width="100%" height="200" viewBox={`0 0 ${W} 200`} role="img" aria-label={`${label}: ${bars.map((b) => `${b.name} ${b.net}`).join(", ")}`}>
      <line x1="10" y1={zero} x2={W - 10} y2={zero} stroke="var(--r-btn)" strokeWidth="1" />
      {bars.map((b, i) => {
        const v = Number(b.net);
        const h = v === 0 ? 0 : Math.max(2, (Math.abs(v) / total) * area);
        const x = 10 + slot * i + slot / 2;
        const color = v >= 0 ? "var(--r-profit)" : "var(--r-loss)";
        return (
          <g key={b.name}>
            <rect x={x - 21} y={v >= 0 ? zero - h : zero} width="42" height={h} rx="3" fill={color} />
            <text x={x} y={v >= 0 ? zero - h - 8 : zero + h + 14} textAnchor="middle" fontFamily="var(--r-mono)" fontSize="11" fill={v === 0 ? "var(--r-muted)" : color}>{money(v)}</text>
            <text x={x} y="192" textAnchor="middle" fontFamily="var(--r-sans)" fontSize="10.5" fill="var(--r-text-2)">{b.name.toUpperCase()}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Curve({ points }: { points: { day: string; equity: string }[] }) {
  if (points.length < 2) return <div className="r-empty" style={{ height: 220, display: "flex", alignItems: "center" }}>Not enough history in this period.</div>;
  const vs = points.map((p) => Number(p.equity));
  const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const d = points.map((p, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * 1000).toFixed(1)} ${(200 - ((Number(p.equity) - min) / span) * 170).toFixed(1)}`).join(" ");
  return (
    <svg width="100%" height="220" viewBox="0 0 1000 220" preserveAspectRatio="none" role="img" aria-label={`Equity from ${money(vs[0])} to ${money(vs[vs.length - 1])}`}>
      {[55, 110, 165].map((y) => <line key={y} x1="0" y1={y} x2="1000" y2={y} stroke="var(--r-row)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
      <path d={d} fill="none" stroke="var(--r-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Trades({ rows }: { rows: TradeRow[] }) {
  if (rows.length === 0) return <div className="r-empty" style={{ padding: "8px 0" }}>None in this period.</div>;
  return (
    <div className="r-table-wrap">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "var(--r-mono)" }}>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.id}>
              {[shortDay(t.closedAt), t.symbol].map((v, j) => <td key={j} style={{ padding: "9px 6px", borderBottom: i < rows.length - 1 ? "1px solid var(--r-row)" : "none", color: j === 0 ? "var(--r-text-2)" : undefined }}>{v}</td>)}
              <td className={t.side === "BUY" ? "profit" : "loss"} style={{ padding: "9px 6px", borderBottom: i < rows.length - 1 ? "1px solid var(--r-row)" : "none", fontWeight: 600 }}>{t.side}</td>
              <td style={{ padding: "9px 6px", borderBottom: i < rows.length - 1 ? "1px solid var(--r-row)" : "none", textAlign: "right" }}>{t.lots}</td>
              <td style={{ padding: "9px 6px", borderBottom: i < rows.length - 1 ? "1px solid var(--r-row)" : "none", textAlign: "right", color: t.r == null ? "var(--r-pending)" : "var(--r-text-2)" }}>{t.r == null ? "NO SL" : `${t.r}R`}</td>
              <td className={pnlClass(t.net)} style={{ padding: "9px 6px", borderBottom: i < rows.length - 1 ? "1px solid var(--r-row)" : "none", textAlign: "right" }}>{money(t.net)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RoomAnalytics() {
  const { data: room } = useRoom();
  const [account, setAccount] = useState("all");
  const [period, setPeriod] = useState("90d");
  const [d, setD] = useState<Data | null>(null);
  const [tick, setTick] = useState(0);
  useRoomEvent(() => setTick((t) => t + 1));
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/room/analytics?account=${account}&period=${period}`, { cache: "no-store" });
      if (res.ok && live) setD(await res.json());
    })();
    return () => { live = false; };
  }, [account, period, tick]);

  const ccy = d?.currency ?? "USD";
  const right = (
    <>
      <label htmlFor="aacct" className="r-flabel">Account</label>
      <select id="aacct" className="mono" style={sel} value={account} onChange={(e) => setAccount(e.target.value)}>
        <option value="all">All accounts</option>
        {(room?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{`${a.accountNumber} · ${a.mode === "DEMO" ? "Demo" : a.plan}`}</option>)}
      </select>
      <label htmlFor="aper" className="r-flabel">Period</label>
      <select id="aper" style={sel} value={period} onChange={(e) => setPeriod(e.target.value)}>
        <option value="90d">Last 90 days</option><option value="30d">Last 30 days</option><option value="ytd">This year</option><option value="all">All time</option>
      </select>
      <a className="r-btn-ghost" style={{ fontSize: 12.5, padding: "8px 14px" }} href={`/api/room/analytics?account=${account}&period=${period}&format=csv`} download>Export report</a>
    </>
  );
  const t = d?.tiles;
  const tiles: [string, string, string][] = t ? [
    [`Net P/L · ${ccy}`, money(t.net), pnlClass(t.net)],
    ["Win rate", `${t.winRate}%`, ""],
    ["Profit factor", t.profitFactor ?? "0.00", ""],
    ["Trades", String(t.trades), ""],
    ["Volume · lots", t.lots, ""],
    ["Avg win / avg loss", `${money(t.avgWin)} / ${money(t.avgLoss)}`, ""],
  ] : [];
  const r = d?.risk;
  return (
    <>
      <RoomHeader title="Analytics" right={right} picker={false} />
      <div className="r-body" style={{ gap: 22 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
          {tiles.map(([label, v, cls], i) => (
            <div key={label} className="r-card r-tile">
              <div className="r-label" style={{ letterSpacing: 1.2 }}>{label}</div>
              <div className={`r-tile-v ${cls}`} style={{ fontSize: i === 5 ? 16 : 21, marginTop: i === 5 ? 12 : 8 }}>{v}</div>
            </div>
          ))}
        </div>

        <div className="r-card" style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
            <div className="r-label">Equity curve · {account === "all" ? "all accounts" : room?.accounts.find((a) => a.id === account)?.accountNumber} · {PERIOD_LABEL[period]}</div>
            {d && d.curve.length ? <div className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)" }}>{monDay(d.curve[0].day)} TO {monDay(d.curve[d.curve.length - 1].day)}</div> : null}
          </div>
          {d ? <Curve points={d.curve} /> : <div style={{ height: 220 }} />}
          {d && d.curve.length > 1 ? (
            <div className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--r-muted)", marginTop: 8, gap: 10 }}>
              <span>{money(d.curve[0].equity)}</span>
              {d.curveLow ? <span>Low {money(d.curveLow.equity)} · {shortDay(d.curveLow.day)}</span> : null}
              <span>{money(d.curve[d.curve.length - 1].equity)}</span>
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 12 }}>P/L by session · {ccy}</div>
            {d ? <Bars bars={d.bySession} label="Profit and loss by trading session" /> : null}
            {d?.sessionCaption ? <div style={{ fontSize: 12, color: "var(--r-text-2)", marginTop: 10 }}>{d.sessionCaption}</div> : null}
          </div>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 12 }}>P/L by day of week · {ccy}</div>
            {d ? <Bars bars={d.byDayOfWeek} label="Profit and loss by weekday" /> : null}
            {d?.dayCaption ? <div style={{ fontSize: 12, color: "var(--r-text-2)", marginTop: 10 }}>{d.dayCaption}</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 14 }}>P/L by symbol · {ccy}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
              {(d?.bySymbol ?? []).map((s) => {
                const max = Math.max(1, ...(d?.bySymbol ?? []).map((x) => Math.abs(Number(x.net))));
                const v = Number(s.net);
                return (
                  <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span className="mono" style={{ width: 72, flexShrink: 0 }}>{s.name}</span>
                    <span style={{ flex: 1, height: 14, background: "var(--r-card-2)", borderRadius: 3, overflow: "hidden" }}><span style={{ display: "block", width: `${Math.max(2, (Math.abs(v) / max) * 100)}%`, height: "100%", background: v >= 0 ? "var(--r-profit)" : "var(--r-loss)", borderRadius: 3 }} /></span>
                    <span className={`mono ${pnlClass(v)}`} style={{ width: 84, textAlign: "right", flexShrink: 0 }}>{money(v)}</span>
                  </div>
                );
              })}
              {d && d.bySymbol.length === 0 ? <div className="r-note">No closed trades in this period.</div> : null}
            </div>
            {d?.symCaption ? <div style={{ fontSize: 12, color: "var(--r-text-2)", marginTop: 16 }}>{d.symCaption}</div> : null}
          </div>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 14 }}>Risk</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14, fontSize: 12.5 }}>
              {r ? ([
                ["Avg risk per trade", r.avgRiskPct != null ? `${r.avgRiskPct}%` : "No stops", ""],
                ["Avg R multiple", r.avgWinR != null ? `1 : ${r.avgWinR}` : "No stops", ""],
                ["Max drawdown", r.maxDrawdownPct != null ? (Number(r.maxDrawdownPct) > 0 ? `-${r.maxDrawdownPct}%` : "0.0%") : "0.0%", Number(r.maxDrawdownPct ?? 0) > 0 ? "var(--r-loss)" : ""],
                ["Longest win streak", String(r.longestWin), ""],
                ["Longest loss streak", String(r.longestLoss), ""],
                ["Avg hold time", hold(r.avgHoldMinutes), ""],
                ["Trades without SL", String(r.withoutSl), r.withoutSl > 0 ? "var(--r-pending)" : ""],
                ["Largest single loss", money(r.largestLoss), Number(r.largestLoss) < 0 ? "var(--r-loss)" : ""],
              ] as const).map(([k, v, c]) => (
                <div key={k}><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 4 }}>{k}</div><div className="mono" style={{ fontSize: 16, fontWeight: 600, color: c || undefined }}>{v}</div></div>
              )) : null}
            </div>
            {d?.riskCaption ? <div style={{ fontSize: 12, color: "var(--r-text-2)", marginTop: 16, borderTop: "1px solid var(--r-line)", paddingTop: 14 }}>{d.riskCaption}</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 12 }}>Best trades</div>
            <Trades rows={d?.best ?? []} />
            {d?.best.length ? <a href={`/room/journal?trade=${d.best[0].id}`} style={{ display: "inline-block", marginTop: 12, fontSize: 12.5, fontWeight: 500 }}>Open in journal</a> : null}
          </div>
          <div className="r-card" style={{ ...card, flex: "1 1 340px", minWidth: 0 }}>
            <div className="r-label" style={{ marginBottom: 12 }}>Worst trades</div>
            <Trades rows={d?.worst ?? []} />
            {d?.worst.length ? <a href={`/room/journal?trade=${d.worst[0].id}`} style={{ display: "inline-block", marginTop: 12, fontSize: 12.5, fontWeight: 500 }}>Open in journal</a> : null}
          </div>
        </div>

        <div className="r-card" style={{ ...card, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="r-label">Per account</div>
          {(d?.perAccount ?? []).map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap", fontSize: 12.5 }}>
              <span className="mono" style={{ minWidth: 170 }}>{a.accountNumber} · <span style={{ fontFamily: "var(--r-sans)" }}>{a.plan}</span></span>
              <span className={`mono ${pnlClass(a.net)}`} style={{ minWidth: 100, fontWeight: 600 }}>{money(a.net)}</span>
              <span className="mono" style={{ color: "var(--r-muted)" }}>{a.lots} lots · {a.trades} trades</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
