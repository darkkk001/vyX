"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent, type RoomAccount } from "@/components/room/RoomData";
import TopUpButton from "@/components/room/TopUpButton";
import { OpenAccountButton } from "@/components/room/OpenAccountModal";
import AccountDrawer, { type LevRow } from "@/components/room/AccountDrawer";
import WalletPanel from "@/components/room/WalletPanel";
import { money, day } from "@/components/room/format";

// Accounts: Real / Demo / Funding wallet. Each account is a card; its three-dot opens the Settings drawer. Archived
// accounts sit below, with Restore.
type Tab = "LIVE" | "DEMO" | "WALLET";
type Archived = { id: string; accountNumber: string; nickname: string | null; mode: "LIVE" | "DEMO"; plan: string; balance: string; currency: string; at: string };
type Meta = { leverage: LevRow[]; archived: Archived[]; liveRequest: { at: string } | null };
type Sort = "newest" | "oldest" | "balance" | "number";
const SORTS: { value: Sort; label: string }[] = [{ value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }, { value: "balance", label: "Highest balance" }, { value: "number", label: "Account number" }];
const VIEW_KEY = "room-accounts-view";

function sorted(list: RoomAccount[], sort: Sort): RoomAccount[] {
  const by: Record<Sort, (a: RoomAccount, b: RoomAccount) => number> = {
    newest: (a, b) => b.openedAt.localeCompare(a.openedAt),
    oldest: (a, b) => a.openedAt.localeCompare(b.openedAt),
    balance: (a, b) => Number(b.figures.balance) - Number(a.figures.balance),
    number: (a, b) => a.accountNumber.localeCompare(b.accountNumber),
  };
  return [...list].sort(by[sort]);
}

function AccountCard({ a, pending, list, onSettings }: { a: RoomAccount; pending: number | null; list: boolean; onSettings: () => void }) {
  const live = a.mode === "LIVE";
  return (
    <div className="r-card r-acct-card" id={`acct-${a.accountNumber}`} data-list={list} data-account={a.accountNumber}>
      <div style={{ minWidth: 0, flex: "1 1 200px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="r-plan-chip">{a.plan}</span>
          <span className={`r-mode ${live ? "r-mode-live" : "r-mode-demo"}`}><span className="r-dot" />{live ? "REAL" : "DEMO"}</span>
          {pending ? <span className="r-chip-pending" style={{ fontSize: 11 }}>1:{pending} pending</span> : null}
        </div>
        <div className="mono" style={{ fontSize: 16, fontWeight: 600, marginTop: 10 }}>{a.accountNumber}</div>
        <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 3, minHeight: 18, overflowWrap: "anywhere" }}>{a.nickname ?? ""}</div>
      </div>
      <div style={{ flex: "0 1 150px" }}>
        <div className="r-label" style={{ fontSize: 10, letterSpacing: 1 }}>Balance</div>
        <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{money(a.figures.balance)} <span style={{ fontSize: 11.5, color: "var(--r-muted)", fontWeight: 400 }}>{a.currency}</span></div>
        <div style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 3 }}>Opened {day(a.openedAt)}</div>
      </div>
      <div className="r-acct-actions">
        <a className="r-btn r-btn-sm" href={`/trade?account=${encodeURIComponent(a.accountNumber)}`} target="_blank" rel="noopener">Trade</a>
        {live ? null : <TopUpButton account={a} className="r-btn-ghost r-btn-sm" />}
        {live ? <a className="r-btn-ghost r-btn-sm" href={`/room/deposit?account=${a.id}`}>Deposit</a> : null}
        {live ? <a className="r-btn-ghost r-btn-sm" href={`/room/withdraw?account=${a.id}`}>Withdraw</a> : null}
        <a className="r-btn-ghost r-btn-sm" href={`/room/transfer?from=${a.id}`}>Transfer</a>
        <button type="button" className="r-icon-btn" aria-label={`Settings for ${a.accountNumber}`} onClick={onSettings}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="7" cy="2.5" r="1.3" /><circle cx="7" cy="7" r="1.3" /><circle cx="7" cy="11.5" r="1.3" /></svg>
        </button>
      </div>
    </div>
  );
}

export default function RoomAccounts() {
  const { data, refresh } = useRoom();
  const [tab, setTab] = useState<Tab>("LIVE");
  const [sort, setSort] = useState<Sort>("newest");
  const [view, setView] = useState<"list" | "grid">("list");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [drawerId, setDrawerId] = useState("");
  const [restoreMsg, setRestoreMsg] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    try { if (localStorage.getItem(VIEW_KEY) === "grid") setView("grid"); } catch { /* the default view is fine */ }
    if (new URLSearchParams(window.location.search).get("tab") === "wallet") setTab("WALLET");
  }, []);
  const pickView = (v: "list" | "grid") => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* not kept, still shown */ } };

  const load = useCallback(async () => {
    const res = await fetch("/api/room/accounts?mode=LIVE", { cache: "no-store" });
    if (res.ok) setMeta(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });
  useEffect(() => {
    const on = () => { void load(); };
    window.addEventListener("room:accounts-changed", on);
    return () => window.removeEventListener("room:accounts-changed", on);
  }, [load]);

  const accounts = useMemo(() => data?.accounts ?? [], [data]);
  const shown = useMemo(() => sorted(accounts.filter((a) => a.mode === tab), sort), [accounts, tab, sort]);
  const drawer = accounts.find((a) => a.id === drawerId) ?? null;
  const levOf = (id: string) => meta?.leverage.find((l) => l.accountId === id) ?? null;
  const changed = useCallback(async () => { await Promise.all([refresh(), load()]); }, [refresh, load]);

  async function restore(id: string) {
    setRestoreMsg(null);
    const res = await fetch(`/api/room/accounts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore" }) });
    const b = await res.json().catch(() => null);
    if (!res.ok) { setRestoreMsg({ id, text: b?.error ?? "Could not restore." }); return; }
    await changed();
  }

  const tabBtn = (t: Tab, label: string) => (
    <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className="r-acct-tab" data-on={tab === t}>{label}</button>
  );
  const archived = (meta?.archived ?? []).filter((a) => tab === "WALLET" || a.mode === tab);
  return (
    <>
      <RoomHeader title="Accounts" />
      <div className="r-body">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div role="tablist" aria-label="Account type" style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--r-line)", minWidth: 0 }}>
            {tabBtn("LIVE", "Real")}
            {tabBtn("DEMO", "Demo")}
            {tabBtn("WALLET", "Funding wallet")}
          </div>
          <OpenAccountButton mode={tab === "DEMO" ? "DEMO" : "LIVE"} className="r-btn r-btn-sm">Open account</OpenAccountButton>
        </div>

        {tab === "WALLET" ? <WalletPanel /> : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--r-text-2)" }}>
                Sort
                <select aria-label="Sort accounts" className="r-input" style={{ padding: "6px 10px", fontSize: 12.5 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <div role="group" aria-label="View" style={{ display: "inline-flex", gap: 6 }}>
                <button type="button" className="r-icon-btn" aria-label="List view" aria-pressed={view === "list"} data-on={view === "list"} onClick={() => pickView("list")}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 3.5h10M2 7h10M2 10.5h10" /></svg>
                </button>
                <button type="button" className="r-icon-btn" aria-label="Grid view" aria-pressed={view === "grid"} data-on={view === "grid"} onClick={() => pickView("grid")}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="2" width="4" height="4" /><rect x="8" y="2" width="4" height="4" /><rect x="2" y="8" width="4" height="4" /><rect x="8" y="8" width="4" height="4" /></svg>
                </button>
              </div>
            </div>
            {tab === "LIVE" && meta?.liveRequest ? <div className="r-note">Your real account request is with your broker.</div> : null}
            <div className={view === "grid" ? "r-acct-grid" : "r-acct-list"}>
              {shown.map((a) => <AccountCard key={a.id} a={a} list={view === "list"} pending={levOf(a.id)?.pending?.to ?? null} onSettings={() => setDrawerId(a.id)} />)}
            </div>
            {data && shown.length === 0 ? <div className="r-card r-pad r-empty">No {tab === "LIVE" ? "real" : "demo"} accounts yet.</div> : null}
          </>
        )}

        {tab !== "WALLET" && archived.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="r-label">Archived accounts</div>
            {archived.map((a) => (
              <div key={a.id} className="r-card" data-archived={a.accountNumber} style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <span className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>{a.accountNumber}</span>
                  <span style={{ fontSize: 12.5, color: "var(--r-text-2)", marginLeft: 10 }}>{a.plan}{a.nickname ? ` · ${a.nickname}` : ""}</span>
                  <div style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 3 }}>Archived {day(a.at)}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {restoreMsg?.id === a.id ? <span className="r-error" role="status">{restoreMsg.text}</span> : null}
                  <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => restore(a.id)}>Restore</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {drawer ? <AccountDrawer key={drawer.id} account={drawer} lev={levOf(drawer.id)} onClose={() => setDrawerId("")} onChanged={changed} /> : null}
    </>
  );
}
