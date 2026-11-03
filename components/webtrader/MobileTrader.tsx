"use client";

// The phone WebTrader (max-width 860 px), laid out after the native Futurix / QoreTrader mobile app
// (qoretrader-mobile, lib/features/*): QUOTES · CHARTS · TRADE · HISTORY · SETTINGS. Presentational only: every figure,
// list and action comes from WebTrader.tsx, which owns the state, the trading calls and the dialogs.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import MobileIcon, { type MobileGlyph } from "./MobileIcon";

export type MobileTab = "quotes" | "charts" | "trade" | "history" | "settings" | "order";

export const MOBILE_TABS: { key: Exclude<MobileTab, "order">; label: string; glyph: MobileGlyph }[] = [
  { key: "quotes", label: "QUOTES", glyph: "quotes" },
  { key: "charts", label: "CHARTS", glyph: "charts" },
  { key: "trade", label: "TRADE", glyph: "trade" },
  { key: "history", label: "HISTORY", glyph: "history" },
  { key: "settings", label: "SETTINGS", glyph: "settings" },
];

export type MQuote = {
  name: string;
  digits: number;
  bid: number;
  ask: number;
  ticked: boolean;
  changePct: number | null;
  sub: string;
};
export type MPosition = {
  id: string;
  label: string; // "#123456" or the id tail
  symbol: string;
  digits: number;
  side: "BUY" | "SELL";
  volume: number;
  openPrice: number;
  current: number | null;
  sl: number | null;
  tp: number | null;
  pnl: number;
  openedAt: string;
};
export type MOrder = { id: string; symbol: string; digits: number; side: "BUY" | "SELL"; type: string; volume: number; price: number | null; status: string };
export type MHistRow =
  | { kind: "trade"; key: string; symbol: string; digits: number; side: "BUY" | "SELL"; lots: string; open: number; close: number | null; net: number; openedAt: string; at: string; voided: boolean; partial: boolean }
  | { kind: "funds"; key: string; label: string; amount: number; note: string; at: string };
export type MSummary = { profit: number; deposit: number; swap: number; commission: number; balance: number; trades: number; winRate: string; credit: number } | null;
export type MLinked = { accountNumber: string; accountMode: "DEMO" | "LIVE"; balance: string; currency: string };
export type MAccount = { number: string; name: string; mode: "DEMO" | "LIVE"; plan: string; currency: string; leverage: number; balance: number };
export type MFigures = { balance: number; equity: number; margin: number; freeMargin: number; marginLevel: number; pnl: number; marginCall: boolean };

// money as the native app writes it: thousands commas, 2 dp, a true minus, no plus; the colour carries the sign
export function mMoney(v: number) {
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < -0.004 ? `−${s}` : s;
}
const tone = (v: number) => (v > 0.004 ? "m-up" : v < -0.004 ? "m-down" : "");
const pct = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}%`;
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function whenShort(iso: string) {
  const d = new Date(iso);
  return sameDay(d, new Date()) ? hm(d) : `${d.getDate()} ${MON[d.getMonth()]} ${hm(d)}`;
}
function dayLabel(d: Date) {
  const now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "TODAY";
  if (sameDay(d, y)) return "YESTERDAY";
  return `${DAY[d.getDay()]} · ${MON[d.getMonth()]} ${d.getDate()}`;
}

function Mark({ logoUrl, name, size }: { logoUrl: string | null; name: string; size: number }) {
  return (
    <span className={`m-mark${logoUrl ? " m-mark-img" : ""}`} style={{ width: size, height: size, borderRadius: size / 4 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {logoUrl ? <img src={logoUrl} alt="" /> : <span>{name.charAt(0).toUpperCase()}</span>}
    </span>
  );
}

export function MHeader({ title, logoUrl, brokerName, children }: { title: string; logoUrl: string | null; brokerName: string; children?: React.ReactNode }) {
  return (
    <div className="m-head">
      <Mark logoUrl={logoUrl} name={brokerName} size={22} />
      <span className="m-title">{title}</span>
      <span className="m-spacer" />
      {children}
    </div>
  );
}

function SquareBtn({ glyph, label, active, onClick }: { glyph: MobileGlyph; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`m-sq${active ? " active" : ""}`} aria-label={label} title={label} onClick={onClick}>
      <MobileIcon glyph={glyph} size={16} />
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return <span className={`m-switch${on ? " on" : ""}`} aria-hidden="true"><span /></span>;
}

// ---------------------------------------------------------------------------------------------------- tab bar
export function MTabBar({ tab, onTab }: { tab: MobileTab; onTab: (t: MobileTab) => void }) {
  return (
    <nav className="mobile-nav" aria-label="Sections">
      {MOBILE_TABS.map((t) => {
        const active = tab === t.key || (t.key === "trade" && tab === "order");
        return (
          <button key={t.key} type="button" className={`mobile-nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => onTab(t.key)}>
            <MobileIcon glyph={t.glyph} size={18} />
            <span>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------- quotes
// tick direction is sticky: an unchanged bid keeps the last direction (the native app's rule)
function useTickDirections(quotes: MQuote[]) {
  const ref = useRef(new Map<string, { bid: number; dir: "" | "m-tick-up" | "m-tick-down" }>());
  const map = ref.current;
  for (const q of quotes) {
    if (!q.ticked) continue;
    const prev = map.get(q.name);
    if (!prev) map.set(q.name, { bid: q.bid, dir: "" });
    else if (q.bid !== prev.bid) map.set(q.name, { bid: q.bid, dir: q.bid > prev.bid ? "m-tick-up" : "m-tick-down" });
  }
  return map;
}

function QuoteRows({ quotes, onSelect }: { quotes: MQuote[]; onSelect: (name: string) => void }) {
  const dirs = useTickDirections(quotes);
  return (
    <>
      {quotes.map((q) => {
        const spr = q.ticked ? Math.round((q.ask - q.bid) * 10 ** q.digits) : null;
        return (
          <button key={q.name} type="button" className="m-quote" onClick={() => onSelect(q.name)}>
            <span className="m-q-sym">
              <span className="m-sym">{q.name}</span>
              <span className="m-q-sub">{spr !== null ? `SPR ${spr} · ${q.sub}` : q.sub}</span>
            </span>
            <span className={`m-q-num m-price ${dirs.get(q.name)?.dir ?? ""}`}>{q.ticked ? q.bid.toFixed(q.digits) : ""}</span>
            <span className="m-q-num m-price m-ask">{q.ticked ? q.ask.toFixed(q.digits) : ""}</span>
            <span className={`m-q-num m-chg ${q.changePct === null ? "" : q.changePct >= 0 ? "m-tick-up" : "m-tick-down"}`}>{q.changePct === null ? "" : pct(q.changePct)}</span>
          </button>
        );
      })}
    </>
  );
}

export function MQuotes(p: {
  logoUrl: string | null; brokerName: string; quotes: MQuote[]; filter: string; onFilter: (v: string) => void;
  onAdd: () => void; onSelect: (name: string) => void;
}) {
  const [searching, setSearching] = useState(p.filter !== "");
  const ticker = p.quotes.slice(0, 8);
  return (
    <div className="m-screen m-quotes">
      <MHeader title="QUOTES" logoUrl={p.logoUrl} brokerName={p.brokerName}>
        <SquareBtn glyph="search" label="Search symbols" active={searching} onClick={() => { if (searching) p.onFilter(""); setSearching((v) => !v); }} />
        <SquareBtn glyph="plus" label="Add symbol" onClick={p.onAdd} />
      </MHeader>
      {searching ? (
        <div className="m-search">
          <input autoFocus placeholder="SYMBOL" value={p.filter} onChange={(e) => p.onFilter(e.target.value)} aria-label="Search symbols" />
        </div>
      ) : null}
      <div className="m-cols"><span>SYMBOL</span><span>BID</span><span>ASK</span><span>CHG</span></div>
      <div className="m-scroll">
        {p.quotes.length === 0 ? <div className="m-empty">{p.filter ? "NO SYMBOL MATCHES" : "NO SYMBOLS"}</div> : <QuoteRows quotes={p.quotes} onSelect={p.onSelect} />}
      </div>
      <div className="m-ticker" aria-label="Prices">
        {ticker.map((q) => (
          <span key={q.name} className="m-tick-item">
            <span className="m-tick-sym">{q.name}</span>{" "}
            <span className={q.changePct === null ? "m-ask" : q.changePct >= 0 ? "m-tick-up" : "m-tick-down"}>{q.ticked ? q.bid.toFixed(q.digits) : ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- charts head
export const MOBILE_TFS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"] as const;

export function MChartHead(p: {
  symbol: string; changePct: number | null; tf: string; onTf: (tf: (typeof MOBILE_TFS)[number]) => void;
  quotes: MQuote[]; onSelect: (name: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  return (
    <div className="m-chart-head">
      <div className="m-symbar">
        <button type="button" className="m-symbtn" onClick={() => setPicker(true)} aria-label="Change symbol">
          <span className="m-title m-title-sym">{p.symbol || "CHARTS"}</span>
          <span className="m-chev"><MobileIcon glyph="chevronDown" size={14} /></span>
          {p.changePct === null ? null : <span className={`m-chg ${p.changePct >= 0 ? "m-tick-up" : "m-tick-down"}`}>{pct(p.changePct)}</span>}
        </button>
      </div>
      <div className="m-tfs" role="group" aria-label="Timeframe">
        {MOBILE_TFS.map((tf) => (
          <button key={tf} type="button" className={`m-pill${p.tf === tf ? " active" : ""}`} aria-pressed={p.tf === tf} onClick={() => p.onTf(tf)}>{tf}</button>
        ))}
      </div>
      {picker ? (
        <div className="m-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) setPicker(false); }}>
          <div className="m-sheet" role="dialog" aria-label="Symbol">
            <div className="m-sheet-title">SYMBOL</div>
            <div className="m-scroll"><QuoteRows quotes={p.quotes} onSelect={(n) => { setPicker(false); p.onSelect(n); }} /></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- trade
function AccountCard({ f, brokerName, mode, ccy, leverage, hidden }: { f: MFigures; brokerName: string; mode: "DEMO" | "LIVE" | null; ccy: string; leverage: number | null; hidden: boolean }) {
  const h = (s: string) => (hidden ? "••••" : s);
  const lvl = isFinite(f.marginLevel) ? `${f.marginLevel.toFixed(1)}%` : "";
  return (
    <div className="m-card m-acct">
      <div className="m-acct-top">
        <div>
          <div className="m-micro">OPEN P/L · {ccy}</div>
          <div className={`m-pnl ${tone(f.pnl)}`}>{h(mMoney(f.pnl))}</div>
        </div>
        <div className="m-acct-broker">
          {brokerName.toUpperCase()}{mode ? <> · <b className={mode === "LIVE" ? "m-gold" : ""}>{mode}</b></> : null}
        </div>
      </div>
      <div className="m-rule" />
      <div className="m-grid">
        <div><span className="m-micro">BALANCE</span><b>{h(mMoney(f.balance))}</b></div>
        <div><span className="m-micro">EQUITY</span><b>{h(mMoney(f.equity))}</b></div>
        <div><span className="m-micro">MARGIN USED</span><b>{h(mMoney(f.margin))}</b></div>
        <div><span className="m-micro">FREE MARGIN</span><b>{h(mMoney(f.freeMargin))}</b></div>
        <div><span className="m-micro">MARGIN LVL</span><b className={lvl ? (f.marginCall ? "m-warn" : "m-ok") : ""}>{h(lvl)}</b></div>
        <div><span className="m-micro">LEVERAGE</span><b>{leverage ? `1:${leverage}` : ""}</b></div>
      </div>
    </div>
  );
}

function PositionRow({ p, child, open, onOpen, onClose, onPartial }: { p: MPosition; child?: boolean; open: boolean; onOpen: () => void; onClose: () => void; onPartial: () => void }) {
  return (
    <>
      <button type="button" className={`m-pos${child ? " child" : ""}`} onClick={onOpen} aria-expanded={open}>
        <span className="m-pos-l1">
          <span className="m-sym">{p.symbol}</span>
          <span className={`m-side ${p.side === "BUY" ? "m-up" : "m-down"}`}>{p.side} {p.volume.toFixed(2)}</span>
          <span className="m-spacer" />
          <span className={`m-sym ${tone(p.pnl)}`}>{mMoney(p.pnl)}</span>
        </span>
        <span className="m-pos-l2">
          <span>{p.openPrice.toFixed(p.digits)} → <span className="m-ask">{p.current === null ? "" : p.current.toFixed(p.digits)}</span></span>
          <span className="m-sltp">
            {p.sl !== null ? <>SL <span className="m-down">{p.sl.toFixed(p.digits)}</span></> : null}
            {p.sl !== null && p.tp !== null ? " · " : null}
            {p.tp !== null ? <>TP <span className="m-up">{p.tp.toFixed(p.digits)}</span></> : null}
          </span>
        </span>
        <span className="m-pos-l3">{p.label} · {whenShort(p.openedAt)}</span>
      </button>
      {open ? (
        <div className="m-row-actions">
          <button type="button" onClick={onPartial}>PARTIAL</button>
          <button type="button" className="m-down" onClick={onClose}>CLOSE</button>
        </div>
      ) : null}
    </>
  );
}

export function MTrade(p: {
  logoUrl: string | null; brokerName: string; mode: "DEMO" | "LIVE" | null; ccy: string; leverage: number | null; figures: MFigures | null; hidden: boolean;
  positions: MPosition[]; orders: MOrder[]; viewKey: string; onNewOrder: () => void;
  onClose: (id: string) => void; onPartial: (id: string) => void; onCancelOrder: (id: string) => void;
}) {
  const storeKey = `vyx-m-positions-view@${p.viewKey}`;
  const [view, setView] = useState<"NET" | "ALL">("NET");
  useEffect(() => {
    try { const v = window.localStorage.getItem(storeKey); if (v === "ALL" || v === "NET") setView(v); } catch { /* default stands */ }
  }, [storeKey]);
  const pickView = (v: "NET" | "ALL") => { setView(v); try { window.localStorage.setItem(storeKey, v); } catch { /* not remembered */ } };
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<string, MPosition[]>();
    for (const x of p.positions) m.set(x.symbol, [...(m.get(x.symbol) ?? []), x]);
    return [...m.entries()];
  }, [p.positions]);
  const row = (x: MPosition, child?: boolean) => (
    <PositionRow key={x.id} p={x} child={child} open={openRow === x.id} onOpen={() => setOpenRow((id) => (id === x.id ? null : x.id))} onClose={() => { setOpenRow(null); p.onClose(x.id); }} onPartial={() => { setOpenRow(null); p.onPartial(x.id); }} />
  );
  return (
    <div className="m-screen m-trade">
      <MHeader title="TRADE" logoUrl={p.logoUrl} brokerName={p.brokerName}>
        <button type="button" className="m-new-order" onClick={p.onNewOrder}><b>+</b> NEW ORDER</button>
      </MHeader>
      <div className="m-scroll">
        {p.figures ? <AccountCard f={p.figures} brokerName={p.brokerName} mode={p.mode} ccy={p.ccy} leverage={p.leverage} hidden={p.hidden} /> : <div className="m-empty" style={{ height: 120 }}>Connecting…</div>}
        <div className="m-pos-head">
          <span className="m-micro m-wide">POSITIONS · {p.positions.length}</span>
          <span className="m-seg" role="group" aria-label="Positions view">
            {(["NET", "ALL"] as const).map((v) => <button key={v} type="button" className={view === v ? "active" : ""} aria-pressed={view === v} onClick={() => pickView(v)}>{v}</button>)}
          </span>
        </div>
        {p.positions.length === 0 ? <div className="m-empty m-empty-row">NO OPEN POSITIONS</div> : null}
        {view === "ALL" || groups.every(([, list]) => list.length === 1)
          ? p.positions.map((x) => row(x))
          : groups.map(([sym, list]) => {
              if (list.length === 1) return row(list[0]);
              const buy = list.filter((x) => x.side === "BUY").reduce((s, x) => s + x.volume, 0);
              const sell = list.filter((x) => x.side === "SELL").reduce((s, x) => s + x.volume, 0);
              const net = buy - sell;
              const pnl = list.reduce((s, x) => s + x.pnl, 0);
              const lots = list.reduce((s, x) => s + x.volume, 0);
              const avg = list.reduce((s, x) => s + x.openPrice * x.volume, 0) / (lots || 1);
              const cur = list[0].current;
              const d = list[0].digits;
              const open = openGroups.has(sym);
              const toggle = () => setOpenGroups((prev) => { const n = new Set(prev); if (n.has(sym)) n.delete(sym); else n.add(sym); return n; });
              return (
                <Fragment key={`g-${sym}`}>
                  <button type="button" className="m-pos m-group" onClick={toggle} aria-expanded={open}>
                    <span className="m-group-chev">{open ? "▾" : "▸"}</span>
                    <span className="m-group-body">
                      <span className="m-pos-l1">
                        <span className="m-sym">{sym}</span>
                        <span className={`m-side ${Math.abs(net) < 1e-9 ? "m-ask" : net > 0 ? "m-up" : "m-down"}`}>{Math.abs(net) < 1e-9 ? "HEDGED" : `${net > 0 ? "BUY" : "SELL"} ${Math.abs(net).toFixed(2)}`}</span>
                        <span className="m-spacer" />
                        <span className={`m-sym ${tone(pnl)}`}>{mMoney(pnl)}</span>
                      </span>
                      <span className="m-pos-l2">
                        <span>{avg.toFixed(d)} → <span className="m-ask">{cur === null ? "" : cur.toFixed(d)}</span></span>
                        <span>NET {net.toFixed(2)}</span>
                      </span>
                      <span className="m-pos-l3">{list.length} POSITIONS</span>
                    </span>
                  </button>
                  {open ? list.map((x) => row(x, true)) : null}
                </Fragment>
              );
            })}
        {p.orders.length > 0 ? (
          <>
            <div className="m-sec-head m-micro m-wide">PENDING · {p.orders.length}</div>
            {p.orders.map((o) => (
              <div key={o.id} className="m-order">
                <span className="m-pos-l1">
                  <span className="m-sym">{o.symbol}</span>
                  <span className="m-side m-gold">{o.side} {o.type} {o.volume.toFixed(2)}</span>
                  <span className="m-spacer" />
                  <span className="m-order-price">{o.price === null ? "" : o.price.toFixed(o.digits)}</span>
                </span>
                <span className="m-pos-l3">
                  <span>{o.status === "PENDING" ? "GTC" : o.status}</span>
                  <button type="button" className="m-link m-down" onClick={() => p.onCancelOrder(o.id)}>CANCEL</button>
                </span>
              </div>
            ))}
          </>
        ) : null}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- history
export type MPeriod = "today" | "7d" | "30d" | "custom";
const PERIODS: { key: MPeriod; label: string }[] = [{ key: "today", label: "TODAY" }, { key: "7d", label: "WEEK" }, { key: "30d", label: "MONTH" }, { key: "custom", label: "CUSTOM" }];

export function MHistory(p: {
  logoUrl: string | null; brokerName: string; rows: MHistRow[]; summary: MSummary | undefined; ccy: string; hidden: boolean;
  period: string; onPeriod: (v: MPeriod) => void; from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; onExport: () => void;
}) {
  // oldest first, the newest next to the summary at the foot (the native app opens at the bottom)
  const rows = useMemo(() => [...p.rows].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()), [p.rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [rows.length, p.summary]);
  const h = (s: string) => (p.hidden ? "••••" : s);
  const days: { label: string; rows: MHistRow[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(new Date(r.at));
    if (days.length === 0 || days[days.length - 1].label !== label) days.push({ label, rows: [] });
    days[days.length - 1].rows.push(r);
  }
  const s = p.summary;
  return (
    <div className="m-screen m-history">
      <MHeader title="HISTORY" logoUrl={p.logoUrl} brokerName={p.brokerName}>
        <SquareBtn glyph="export" label="Statement" onClick={p.onExport} />
      </MHeader>
      <div className="m-periods" role="group" aria-label="Period">
        {PERIODS.map((x) => <button key={x.key} type="button" className={`m-pill${p.period === x.key ? " active" : ""}`} aria-pressed={p.period === x.key} onClick={() => p.onPeriod(x.key)}>{x.label}</button>)}
      </div>
      {p.period === "custom" ? (
        <div className="m-range">
          <input type="date" value={p.from} onChange={(e) => p.onFrom(e.target.value)} aria-label="From" />
          <span>TO</span>
          <input type="date" value={p.to} onChange={(e) => p.onTo(e.target.value)} aria-label="To" />
        </div>
      ) : null}
      <div className="m-scroll" ref={scrollRef}>
        {rows.length === 0 ? <div className="m-empty m-empty-row">NO TRADES IN THIS PERIOD</div> : null}
        {days.map((d) => {
          const trades = d.rows.filter((r) => r.kind === "trade" && !r.voided);
          const net = trades.reduce((sum, r) => sum + (r.kind === "trade" ? r.net : 0), 0);
          return (
            <Fragment key={d.label}>
              <div className="m-day"><span>{d.label}</span>{trades.length ? <span>{trades.length} · {h(mMoney(net))}</span> : null}</div>
              {d.rows.map((r) => {
                if (r.kind === "funds") {
                  return (
                    <div key={r.key} className="m-deal m-funds">
                      <span className="m-funds-bar" />
                      <span className="m-deal-body">
                        <span className="m-pos-l1"><span className="m-funds-label">{r.label}</span><span className="m-spacer" /><span className={`m-sym ${tone(r.amount)}`}>{h(mMoney(r.amount))}</span></span>
                        <span className="m-pos-l3"><span className="m-ellipsis">BALANCE{r.note ? ` · ${r.note}` : ""}</span><span>{hm(new Date(r.at))}</span></span>
                      </span>
                    </div>
                  );
                }
                const o = new Date(r.openedAt);
                const c = new Date(r.at);
                const span = sameDay(o, c) ? `${hm(o)} - ${hm(c)}` : `${MON[o.getMonth()]} ${o.getDate()} · ${hm(o)} - ${hm(c)}`;
                return (
                  <div key={r.key} className={`m-deal${r.voided ? " voided" : ""}`}>
                    <span className="m-deal-body">
                      <span className="m-pos-l1">
                        <span className="m-sym">{r.symbol}</span>
                        <span className={`m-side ${r.side === "BUY" ? "m-up" : "m-down"}`}>{r.side} {Number(r.lots).toFixed(2)}</span>
                        <span className="m-spacer" />
                        <span className={`m-sym ${tone(r.net)}`}>{h(mMoney(r.net))}</span>
                      </span>
                      <span className="m-pos-l3">
                        <span className="m-ellipsis">{r.open.toFixed(r.digits)} → {r.close === null ? "" : r.close.toFixed(r.digits)}{r.partial ? " · PARTIAL" : ""}{r.voided ? " · VOIDED" : ""}</span>
                        <span>{span}</span>
                      </span>
                    </span>
                  </div>
                );
              })}
            </Fragment>
          );
        })}
        {s === undefined ? null : <div className="m-card m-summary">
          <div className="m-summary-head"><span>SUMMARY</span><span>{p.ccy}</span></div>
          {s ? (
            <>
              <div className="m-summary-row"><span>PROFIT</span><b>{h(mMoney(s.profit))}</b></div>
              <div className="m-summary-row"><span>DEPOSIT</span><b>{h(mMoney(s.deposit))}</b></div>
              <div className="m-summary-row"><span>SWAP</span><b>{h(mMoney(s.swap))}</b></div>
              <div className="m-summary-row"><span>COMMISSION</span><b>{h(mMoney(s.commission))}</b></div>
              <div className="m-rule" />
              <div className="m-summary-row m-summary-bal"><span>BALANCE</span><b>{h(mMoney(s.balance))}</b></div>
              <div className="m-summary-foot">
                TRADES <span className="m-ask">{s.trades}</span>{"   "}WIN RATE <span className="m-gold">{s.winRate}%</span>
                {Math.abs(s.credit) >= 0.005 ? <>{"   "}CREDIT <span className="m-ask">{h(mMoney(s.credit))}</span></> : null}
              </div>
            </>
          ) : <div className="m-empty" style={{ height: 60 }}>Loading…</div>}
        </div>}
        <div style={{ height: 24 }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------- settings
export function MSettings(p: {
  logoUrl: string | null; brokerName: string; server: string; account: MAccount | null; hidden: boolean; demo: boolean;
  linked: MLinked[] | null; onSwitch: (a: MLinked) => void; onAddAccount: () => void;
  oneClick: boolean; sounds: boolean; light: boolean; chartLabel: string;
  onPassword: () => void; onOneClick: () => void; onSounds: () => void; onTheme: () => void; onChart: () => void;
  onDeposit: () => void; onWithdraw: () => void; onLogout: () => void;
}) {
  const a = p.account;
  const h = (s: string) => (p.hidden ? "••••••" : s);
  const rows: { glyph: MobileGlyph; label: string; value: string; toggle?: boolean; on?: boolean; onClick?: () => void }[] = [
    ...(p.demo ? [] : [{ glyph: "lock" as const, label: "Password", value: "CHANGE", onClick: p.onPassword }]),
    { glyph: "trade", label: "Trading", value: p.oneClick ? "1-CLICK ON" : "1-CLICK OFF", toggle: true, on: p.oneClick, onClick: p.onOneClick },
    { glyph: "bell", label: "Sounds", value: p.sounds ? "ON" : "OFF", toggle: true, on: p.sounds, onClick: p.onSounds },
    { glyph: "sun", label: "Theme", value: p.light ? "LIGHT" : "DARK", toggle: true, on: !p.light, onClick: p.onTheme },
    { glyph: "charts", label: "Chart", value: p.chartLabel, onClick: p.onChart },
  ];
  return (
    <div className="m-screen m-settings">
      <MHeader title="SETTINGS" logoUrl={p.logoUrl} brokerName={p.brokerName}>
        {p.demo ? null : <SquareBtn glyph="signOut" label="Log out" onClick={p.onLogout} />}
      </MHeader>
      <div className="m-scroll m-pad">
        <div className="m-card m-acc-card">
          <div className="m-broker-line">
            <Mark logoUrl={p.logoUrl} name={p.brokerName} size={32} />
            <span className="m-broker-id"><b>{p.brokerName}</b>{p.server && p.server !== p.brokerName ? <span>{p.server}</span> : null}</span>
          </div>
          <div className="m-rule" />
          <div className="m-acc-id">
            <span className="m-acc-who">
              <span className="m-micro">{(a?.plan ?? "").toUpperCase()}</span>
              <b>{h(a?.name ?? "")}</b>
              <span className="m-acc-num">{a?.number ?? ""}</span>
            </span>
            {a ? <span className={`m-kind${a.mode === "LIVE" ? " live" : ""}`}>{a.mode}</span> : null}
          </div>
          <div className="m-micro">BALANCE · {a?.currency ?? ""}</div>
          <div className="m-big-bal">{a ? h(mMoney(a.balance)) : ""}</div>
          <div className="m-rule" />
          <div className="m-micro">LEVERAGE <b className="m-lev">{a ? `1:${a.leverage}` : ""}</b></div>
          {p.demo ? null : (
            <div className="m-acc-btns">
              <button type="button" className="m-btn-gold" onClick={p.onDeposit}>DEPOSIT</button>
              <button type="button" className="m-btn-plain" onClick={p.onWithdraw}>WITHDRAW</button>
            </div>
          )}
        </div>
        {p.demo ? null : (
          <>
            <div className="m-sec-label">MY ACCOUNTS</div>
            {a ? (
              <div className="m-acc-item active">
                <span className="m-acc-line">{a.plan} · {h(a.name)} · {a.number} · <b className={a.mode === "LIVE" ? "m-gold" : "m-label"}>{a.mode}</b></span>
                <span className="m-acc-server">{p.server}</span>
              </div>
            ) : null}
            {(p.linked ?? []).map((l) => (
              <button key={l.accountNumber} type="button" className="m-acc-item" onClick={() => p.onSwitch(l)}>
                <span className="m-acc-line">{l.accountNumber} · <b className={l.accountMode === "LIVE" ? "m-gold" : "m-label"}>{l.accountMode}</b></span>
                <span className="m-acc-server">{h(`${mMoney(parseFloat(l.balance))} ${l.currency}`)}</span>
              </button>
            ))}
            <button type="button" className="m-add-acc" onClick={p.onAddAccount}><MobileIcon glyph="plus" size={12} /> ADD ACCOUNT</button>
          </>
        )}
        <div className="m-sec-label">SETTINGS</div>
        {rows.map((r) => (
          <button key={r.label} type="button" className="m-set-row" onClick={r.onClick} aria-pressed={r.toggle ? r.on : undefined}>
            <span className="m-set-icon"><MobileIcon glyph={r.glyph} size={15} /></span>
            <span className="m-set-label">{r.label}</span>
            <span className={`m-set-value${r.toggle && r.on ? " m-gold" : ""}`}>{r.value}</span>
            {r.toggle ? <Toggle on={!!r.on} /> : <span className="m-faint"><MobileIcon glyph="chevronRight" size={14} /></span>}
          </button>
        ))}
        <div style={{ height: 28 }} />
      </div>
    </div>
  );
}
