"use client";

import { useRoom } from "./RoomData";
import { money } from "./format";

// The top bar's money line (owner 2026-11-09): the client's real money, the funding wallet's balance, never an account's
// and never demo money; 0.00 until the client has real funds. The figure is the server's (overview realFunds).
export default function WalletBalance({ row = false }: { row?: boolean }) {
  const { data } = useRoom();
  if (!data) return null;
  const f = data.realFunds;
  const icon = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 4.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7Z" /><path d="M2.5 4.5 10.5 2.5v2" /><path d="M11 8.5h2.5" />
    </svg>
  );
  if (row) {
    return <div className="r-user-row"><span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>{icon}Wallet</span><span className="mono">{money(f.amount)} {f.currency}</span></div>;
  }
  return (
    <a className="r-head-bal r-head-wallet" href="/room/accounts" title="Funding wallet" aria-label={`Funding wallet ${money(f.amount)} ${f.currency}`}>
      <span style={{ color: "var(--r-muted)", display: "inline-flex" }}>{icon}</span>
      {money(f.amount)} <span style={{ color: "var(--r-muted)", fontWeight: 400 }}>{f.currency}</span>
    </a>
  );
}
