"use client";

import { useCallback, useEffect, useState } from "react";
import { useRoom, useRoomEvent, type RoomAccount } from "./RoomData";
import TopUpButton from "./TopUpButton";
import type { LevRow } from "./AccountDrawer";
import { money } from "./format";

// One account card, the same on the Dashboard and on Accounts (owner 2026-11-10, Exness-style): chips for the platform
// and the plan, "#number" and the nickname; balance and equity; Trade (accent), Deposit, Withdraw, Transfer and the
// three-dot that opens the account's Settings drawer (components/room/AccountDrawer.tsx). Demo: Trade, Top up, three-dot.
// Leverage is in Settings; a pending leverage change shows as a chip in the header and in Settings. The platform chip is the
// broker's own short brand, from the server (lib/room/platform-brand.ts): never the technology's name.
export default function AccountCard({ a, list = false, pending = null, onSettings }: { a: RoomAccount; list?: boolean; pending?: number | null; onSettings: () => void }) {
  const live = a.mode === "LIVE";
  const platform = useRoom().data?.platform;
  return (
    <div className="r-card r-acct-card" id={`acct-${a.accountNumber}`} data-list={list} data-account={a.accountNumber}>
      <div className="r-acct-head">
        {platform ? <span className="r-plan-chip r-plat-chip" title={platform.name}>{platform.short}</span> : null}
        <span className="r-plan-chip">{a.plan}</span>
        <span className="mono r-acct-no">#{a.accountNumber}</span>
        {a.nickname ? <span className="r-acct-nick">{a.nickname}</span> : null}
        {pending ? <span className="r-chip-pending" style={{ fontSize: 11 }}>1:{pending} pending</span> : null}
      </div>
      <div className="r-acct-figs">
        <div>
          <div className="r-label" style={{ fontSize: 10, letterSpacing: 1 }}>Balance</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{money(a.figures.balance)} <span style={{ fontSize: 11.5, color: "var(--r-muted)", fontWeight: 400 }}>{a.currency}</span></div>
        </div>
        <div>
          <div className="r-label" style={{ fontSize: 10, letterSpacing: 1 }}>Equity</div>
          <div className="mono" style={{ fontSize: 14.5, marginTop: 6 }}>{money(a.figures.equity)}</div>
        </div>
      </div>
      <div className="r-acct-actions">
        <a className="r-btn r-btn-sm" href={`/trade?account=${encodeURIComponent(a.accountNumber)}`} target="_blank" rel="noopener">Trade</a>
        {live ? (
          <>
            <a className="r-btn-ghost r-btn-sm" href={`/room/deposit?account=${a.id}`}>Deposit</a>
            <a className="r-btn-ghost r-btn-sm" href={`/room/withdraw?account=${a.id}`}>Withdraw</a>
            <a className="r-btn-ghost r-btn-sm" href={`/room/transfer?from=${a.id}`}>Transfer</a>
          </>
        ) : <TopUpButton account={a} className="r-btn-ghost r-btn-sm" />}
        <button type="button" className="r-icon-btn r-acct-more" aria-label={`Settings for ${a.accountNumber}`} onClick={onSettings}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><circle cx="7" cy="2.5" r="1.3" /><circle cx="7" cy="7" r="1.3" /><circle cx="7" cy="11.5" r="1.3" /></svg>
        </button>
      </div>
    </div>
  );
}

// What the Settings drawer needs besides the account: the leverage rows (current, choices, pending) and the archived list.
export type Archived = { id: string; accountNumber: string; nickname: string | null; mode: "LIVE" | "DEMO"; plan: string; balance: string; currency: string; at: string };
export type AccountsMeta = { leverage: LevRow[]; archived: Archived[]; liveRequest: { at: string } | null };
export function useAccountsMeta() {
  const [meta, setMeta] = useState<AccountsMeta | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/room/accounts?mode=LIVE", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setMeta(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });
  useEffect(() => {
    const on = () => { void load(); };
    window.addEventListener("room:accounts-changed", on);
    return () => window.removeEventListener("room:accounts-changed", on);
  }, [load]);
  const levOf = useCallback((id: string) => meta?.leverage.find((l) => l.accountId === id) ?? null, [meta]);
  return { meta, load, levOf };
}
