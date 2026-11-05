"use client";

import { useCallback, useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { money, pnlClass } from "@/components/room/format";

// Artboard "Trading journal": every closed trade (GET /api/room/journal), filters, and the inspector of one trade with
// the client's rules check, tags and note (GET / PUT /api/room/journal/<id>).
type Row = { id: string; closedAt: string; account: string; symbol: string; side: "BUY" | "SELL"; lots: string; r: string | null; net: string; session: string; tags: string[] };
type List = { rows: Row[]; total: number; page: number; pageSize: number; symbols: string[]; tags: string[] };
type Detail = {
  trade: { id: string; ticket: string; account: string; symbol: string; side: "BUY" | "SELL"; lots: string; net: string; entry: string; exit: string; sl: string | null; riskPct: string | null; r: string | null; openedAt: string; closedAt: string; heldMinutes: number; session: string };
  entry: { tags: string[]; note: string; checklist: Record<string, boolean>; savedAt: string | null };
  rules: { key: string; label: string }[];
  presetTags: string[];
};
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const two = (n: number) => String(n).padStart(2, "0");
const stamp = (iso: string) => { const d = new Date(iso); return `${two(d.getDate())} ${MON[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`; };
const hold = (m: number) => (m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const TAG_COLOR: Record<string, string> = { Plan: "var(--r-ok)", FOMO: "var(--r-pending)", News: "var(--r-loss)", Revenge: "var(--r-loss)", "No SL": "var(--r-pending)" };
const sel = { background: "var(--r-card)", border: "1px solid var(--r-input)", borderRadius: 6, color: "var(--r-text)", fontSize: 12.5, padding: "8px 10px" } as const;

function Tag({ t, small }: { t: string; small?: boolean }) {
  const c = TAG_COLOR[t];
  return <span style={{ fontWeight: 600, color: c ?? "var(--r-text-2)", border: `1px solid ${c ? `color-mix(in srgb, ${c} 40%, transparent)` : "var(--r-btn)"}`, borderRadius: 4, padding: small ? "2px 7px" : "3px 9px", fontSize: 11, fontFamily: "var(--r-sans)", whiteSpace: "nowrap" }}>{t}</span>;
}

export default function RoomJournal() {
  const { data: room } = useRoom();
  const [account, setAccount] = useState("all");
  const [symbol, setSymbol] = useState("all");
  const [tag, setTag] = useState("all");
  const [period, setPeriod] = useState("90d");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<{ tags: string[]; note: string; checklist: Record<string, boolean> } | null>(null);
  const [adding, setAdding] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  useRoomEvent(() => setTick((t) => t + 1));

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("trade");
    if (wanted) setOpenId(wanted);
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(`/api/room/journal?account=${account}&symbol=${encodeURIComponent(symbol)}&tag=${encodeURIComponent(tag)}&period=${period}&page=${page}`, { cache: "no-store" });
      if (!res.ok || !live) return;
      const body: List = await res.json();
      setList(body);
      setOpenId((cur) => cur ?? body.rows[0]?.id ?? null);
    })();
    return () => { live = false; };
  }, [account, symbol, tag, period, page, tick]);
  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/room/journal/${id}`, { cache: "no-store" });
    if (!res.ok) { setDetail(null); return; }
    const body: Detail = await res.json();
    setDetail(body);
    setDraft({ tags: body.entry.tags, note: body.entry.note, checklist: body.entry.checklist });
    setMsg("");
  }, []);
  useEffect(() => { if (openId) void loadDetail(openId); }, [openId, loadDetail]);

  async function save() {
    if (!detail || !draft) return;
    const res = await fetch(`/api/room/journal/${detail.trade.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setMsg(body?.error ?? "Could not save."); return; }
    setMsg("Saved.");
    setList((l) => (l ? { ...l, rows: l.rows.map((r) => (r.id === detail.trade.id ? { ...r, tags: draft.tags } : r)), tags: [...new Set([...l.tags, ...draft.tags])] } : l));
  }
  const toggleTag = (t: string) => setDraft((d) => (d ? { ...d, tags: d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t] } : d));
  const reset = () => { setPage(1); setOpenId(null); };
  const lastPage = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;

  const filters = (
    <>
      <select aria-label="Account" className="mono" style={sel} value={account} onChange={(e) => { setAccount(e.target.value); reset(); }}>
        <option value="all">All accounts</option>
        {(room?.accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.accountNumber}</option>)}
      </select>
      <select aria-label="Symbol" className="mono" style={sel} value={symbol} onChange={(e) => { setSymbol(e.target.value); reset(); }}>
        <option value="all">All symbols</option>
        {(list?.symbols ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <select aria-label="Tag" style={sel} value={tag} onChange={(e) => { setTag(e.target.value); reset(); }}>
        <option value="all">All tags</option>
        {(list?.tags ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select aria-label="Period" style={sel} value={period} onChange={(e) => { setPeriod(e.target.value); reset(); }}>
        <option value="90d">Last 90 days</option><option value="30d">Last 30 days</option><option value="ytd">This year</option><option value="all">All time</option>
      </select>
    </>
  );
  const th = (label: string, right = false) => <th key={label} style={{ fontSize: 10.5, letterSpacing: 1, color: "var(--r-muted)", fontWeight: 600, padding: "12px 8px 8px", borderBottom: "1px solid var(--r-border)", textAlign: right ? "right" : "left", fontFamily: "var(--r-sans)" }}>{label}</th>;
  const t = detail?.trade;
  return (
    <>
      <RoomHeader title="Trading journal" right={filters} picker={false} />
      <div className="r-body" style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div className="r-card" style={{ flex: "2 1 520px", minWidth: 0, padding: "6px 16px 14px" }}>
          <div className="r-table-wrap">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "var(--r-mono)" }}>
              <thead><tr>{[th("CLOSED"), th("SYMBOL"), th("SIDE"), th("LOTS", true), th("R", true), th(`P/L ${room?.accounts[0]?.currency ?? "USD"}`, true), th("SESSION"), th("TAGS")]}</tr></thead>
              <tbody>
                {(list?.rows ?? []).map((r) => {
                  const on = r.id === openId;
                  const cell = { padding: "10px 8px", borderBottom: "1px solid var(--r-row)", whiteSpace: "nowrap" } as const;
                  return (
                    <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ background: on ? "var(--r-gold-soft)" : undefined, cursor: "pointer" }}>
                      <td style={{ ...cell, color: "var(--r-text-2)" }}><button type="button" onClick={() => setOpenId(r.id)} style={{ background: "none", border: "none", padding: 0, color: "inherit", font: "inherit", cursor: "pointer" }} aria-label={`Open ${r.symbol} closed ${stamp(r.closedAt)}`}>{stamp(r.closedAt)}</button></td>
                      <td style={cell}>{r.symbol}</td>
                      <td style={{ ...cell, fontWeight: 600 }} className={r.side === "BUY" ? "profit" : "loss"}>{r.side}</td>
                      <td style={{ ...cell, textAlign: "right" }}>{r.lots}</td>
                      <td style={{ ...cell, textAlign: "right", color: r.r == null ? "var(--r-pending)" : "var(--r-text-2)" }}>{r.r == null ? "NO SL" : `${r.r}R`}</td>
                      <td style={{ ...cell, textAlign: "right" }} className={pnlClass(r.net)}>{money(r.net)}</td>
                      <td style={{ ...cell, fontFamily: "var(--r-sans)", color: "var(--r-text-2)" }}>{r.session}</td>
                      <td style={cell}><span style={{ display: "inline-flex", gap: 5 }}>{r.tags.slice(0, 2).map((x) => <Tag key={x} t={x} small />)}{r.tags.length > 2 ? <span style={{ color: "var(--r-muted)", fontSize: 11 }}>+{r.tags.length - 2}</span> : null}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {list && list.total === 0 ? <div className="r-empty">No closed trades match these filters.</div> : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--r-muted)" }}>{list ? `Showing ${list.rows.length} of ${list.total} · every closed trade lands here automatically` : " "}</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" aria-label="Previous page" className="mono" disabled={page <= 1} onClick={() => { setPage((p) => p - 1); setOpenId(null); }} style={{ background: "none", border: "1px solid var(--r-btn)", borderRadius: 6, color: page <= 1 ? "var(--r-muted)" : "var(--r-text)", fontSize: 12, padding: "6px 12px", cursor: page <= 1 ? "default" : "pointer" }}>←</button>
              <button type="button" aria-label="Next page" className="mono" disabled={page >= lastPage} onClick={() => { setPage((p) => p + 1); setOpenId(null); }} style={{ background: "none", border: "1px solid var(--r-btn)", borderRadius: 6, color: page >= lastPage ? "var(--r-muted)" : "var(--r-text)", fontSize: 12, padding: "6px 12px", cursor: page >= lastPage ? "default" : "pointer" }}>→</button>
            </div>
          </div>
        </div>

        <div className="r-card" style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {t && draft && detail ? (
            <>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--r-line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{t.symbol} · <span className={t.side === "BUY" ? "profit" : "loss"}>{t.side}</span> {t.lots}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 4 }}>#{t.ticket} · {t.account}</div>
                </div>
                <span className={`mono ${pnlClass(t.net)}`} style={{ fontSize: 15, fontWeight: 600 }}>{money(t.net)}</span>
              </div>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--r-line)" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 11, fontSize: 12 }}>
                  {([["ENTRY", t.entry], ["EXIT", t.exit], ["SL / RISK", t.sl ? `${t.sl}${t.riskPct ? ` · ${t.riskPct}%` : ""}` : "No SL"], ["RESULT", t.r == null ? "No SL" : `${t.r}R`], ["OPENED", stamp(t.openedAt)], ["HELD", hold(t.heldMinutes)]] as const).map(([k, v]) => (
                    <div key={k}><div style={{ color: "var(--r-muted)", fontSize: 10.5, marginBottom: 3 }}>{k}</div><div className="mono" style={{ color: v === "No SL" ? "var(--r-pending)" : undefined }}>{v}</div></div>
                  ))}
                </div>
              </div>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--r-line)" }}>
                <div className="r-label" style={{ marginBottom: 11 }}>Rules check</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 12.5 }}>
                  {detail.rules.map((r) => (
                    <label key={r.key} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
                      <input type="checkbox" checked={draft.checklist[r.key] === true} onChange={(e) => setDraft({ ...draft, checklist: { ...draft.checklist, [r.key]: e.target.checked } })} style={{ accentColor: "var(--r-accent)" }} />
                      {r.label}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--r-line)" }}>
                <div className="r-label" style={{ marginBottom: 11 }}>Tags</div>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
                  {[...new Set([...detail.presetTags, ...draft.tags])].map((x) => (
                    <button key={x} type="button" aria-pressed={draft.tags.includes(x)} onClick={() => toggleTag(x)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", opacity: draft.tags.includes(x) ? 1 : 0.4 }}>
                      <Tag t={x} />
                    </button>
                  ))}
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--r-text-2)", border: "1px solid var(--r-btn)", borderRadius: 4, padding: "3px 9px" }}>{t.session}</span>
                  {showAdd ? (
                    <form onSubmit={(e) => { e.preventDefault(); const v = adding.trim(); if (v && !draft.tags.includes(v)) setDraft({ ...draft, tags: [...draft.tags, v.slice(0, 24)] }); setAdding(""); setShowAdd(false); }} style={{ display: "inline-flex" }}>
                      <input aria-label="New tag" autoFocus maxLength={24} value={adding} onChange={(e) => setAdding(e.target.value)} onBlur={() => setShowAdd(false)} className="r-input" style={{ width: 110, padding: "3px 8px", fontSize: 11.5 }} />
                    </form>
                  ) : (
                    <button type="button" onClick={() => setShowAdd(true)} style={{ background: "none", border: "1px dashed var(--r-dash)", borderRadius: 4, color: "var(--r-muted)", fontSize: 11, fontWeight: 600, padding: "3px 9px", cursor: "pointer" }}>+ Tag</button>
                  )}
                </div>
              </div>
              <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
                <label htmlFor="jnote" className="r-label">Note</label>
                <textarea id="jnote" rows={4} maxLength={4000} className="r-input" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} style={{ fontSize: 12.5, padding: "10px 12px", resize: "vertical", lineHeight: 1.6 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button type="button" className="r-btn r-btn-sm" onClick={save}>Save entry</button>
                  {msg ? <span className={msg === "Saved." ? "r-okmsg" : "r-error"} role="status">{msg}</span> : null}
                </div>
              </div>
            </>
          ) : (
            <div className="r-empty">Pick a trade to see its details.</div>
          )}
        </div>
      </div>
    </>
  );
}
