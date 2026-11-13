"use client";

import { useCallback, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { OpenAccountButton } from "@/components/room/OpenAccountModal";
import StatusChip from "@/components/room/StatusChip";
import TierPanel from "@/components/room/TierPanel";
import AccountCard, { useAccountsMeta } from "@/components/room/AccountCard";
import AccountDrawer from "@/components/room/AccountDrawer";
import { useRoom } from "@/components/room/RoomData";
import { money, pnlClass, dayShort, dayTime, greeting } from "@/components/room/format";

// Artboard "Dashboard": greeting, equity strip of the picked account, account cards, recent transactions,
// verification card, trade-on card. The tier strip sits under the greeting.
const KYC_STATUS: Record<string, string> = { APPROVED: "Approved", PENDING: "Under review", REJECTED: "Rejected", NONE: "Not verified" };
const Check = ({ ok }: { ok: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={ok ? "var(--r-ok)" : "var(--r-muted)"} strokeWidth="1.8" aria-hidden="true">
    {ok ? <path d="m2.5 7.5 3 3 6-6" /> : <circle cx="7" cy="7" r="4.5" />}
  </svg>
);

export default function RoomDashboard() {
  const { data, error, selected, refresh } = useRoom();
  // the card's three-dot opens the same Settings drawer as on Accounts
  const { load, levOf } = useAccountsMeta();
  const [drawerId, setDrawerId] = useState("");
  const drawer = (data?.accounts ?? []).find((a) => a.id === drawerId) ?? null;
  const changed = useCallback(async () => { await Promise.all([refresh(), load()]); }, [refresh, load]);
  // the strip: live accounts only, summed by the server (demo never counts; no live account = 0.00)
  const f = data?.totals ?? null;
  const firstName = data?.client.fullName.split(/\s+/)[0] ?? "";
  // one Live / Demo toggle at My accounts drives the account cards and Recent transactions, live by default
  // (owner 2026-11-09); the strip above stays live-only and History is unchanged
  const [mode, setMode] = useState<"LIVE" | "DEMO">("LIVE");
  const cards = (data?.accounts ?? []).filter((a) => a.mode === mode);
  const recent = (mode === "LIVE" ? data?.recent : data?.recentDemo) ?? [];
  return (
    <>
      <RoomHeader title="Dashboard" />
      <div className="r-body">
        {error && !data ? <div className="r-error">{error}</div> : null}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "var(--r-head)", fontSize: 23, fontWeight: 600 }}>{data ? `${greeting()}, ${firstName}` : " "}</div>
            <div style={{ fontSize: 12.5, color: "var(--r-muted)", marginTop: 4 }}>{data?.client.lastLoginAt ? `Last login ${dayTime(data.client.lastLoginAt)}` : " "}</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <a className="r-btn" href="/room/deposit">Deposit</a>
            <a className="r-btn-ghost" href="/room/withdraw">Withdraw</a>
          </div>
        </div>

        <TierPanel />

        <div className="r-grid-tiles">
          {([["Balance", f?.balance], ["Equity", f?.equity], ["Free margin", f?.freeMargin], ["Floating P/L", f?.floating]] as const).map(([label, v], i) => (
            <div key={label} className="r-card r-tile">
              <div className="r-label">{label}</div>
              <div className={`r-tile-v ${i === 3 ? pnlClass(v) : ""}`}>{f ? money(v) : "0.00"}</div>
            </div>
          ))}
        </div>

        <div>
          <div className="r-sec-head">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div className="r-label">My accounts</div>
              <div className="r-mini-seg" role="group" aria-label="Accounts">
                {(["LIVE", "DEMO"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "LIVE" ? "Live" : "Demo"}</button>
                ))}
              </div>
            </div>
            <a href="/room/accounts">Manage accounts</a>
          </div>
          <div className="r-acct-grid">
            {cards.map((a) => <AccountCard key={a.id} a={a} pending={levOf(a.id)?.pending?.to ?? null} onSettings={() => setDrawerId(a.id)} />)}
            <OpenAccountButton style={{ background: "none", cursor: "pointer", font: "inherit",  border: "1px dashed var(--r-dash)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--r-text-2)", minHeight: 150 }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M11 4v14M4 11h14" /></svg>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Open new account</span>
            </OpenAccountButton>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "stretch" }}>
          <div className="r-card r-pad" style={{ flex: "2 1 480px", minWidth: 0 }}>
            <div className="r-sec-head" style={{ marginBottom: 14 }}>
              <div className="r-label">Recent transactions</div>
              <a href="/room/history" style={{ whiteSpace: "nowrap" }}>View all</a>
            </div>
            <div className="r-table-wrap">
              <table className="r-table" style={{ fontSize: 13 }}>
                <thead>
                  <tr>
                    {["Date", "Type", "Account", `Amount ${selected?.currency ?? "USD"}`, "Status"].map((h, i) => (
                      <th key={h} style={{ padding: "8px 10px", fontSize: 10.5, borderBottom: "1px solid var(--r-border)", textAlign: i === 3 ? "right" : "left" }}>{h.toUpperCase()}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="mono">
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td style={{ padding: 10, color: "var(--r-text-2)" }}>{dayShort(t.at)}</td>
                      <td style={{ padding: 10, fontFamily: "var(--r-sans)" }}>{t.type}</td>
                      <td style={{ padding: 10 }}>{t.account}</td>
                      <td style={{ padding: 10, textAlign: "right" }}>{money(t.amount)}</td>
                      <td style={{ padding: 10, fontFamily: "var(--r-sans)" }}><StatusChip status={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data && recent.length === 0 ? <div className="r-empty">{mode === "LIVE" ? "No live transactions yet." : "No demo transactions yet."}</div> : null}
            </div>
          </div>

          <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            {/* only while KYC is pending, rejected or not submitted; when approved, Trade on takes the column */}
            {data && data.kyc.status !== "APPROVED" ? (
              <div className="r-card r-pad">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div className="r-label">Verification</div>
                  <StatusChip status={KYC_STATUS[data.kyc.status] ?? "Not verified"} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Check ok={false} />Identity document</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Check ok={false} />Proof of address</div>
                </div>
                <a href={data.kyc.status === "PENDING" ? "/room/profile" : "/room/verify"} style={{ display: "inline-block", marginTop: 14, fontSize: 12.5, fontWeight: 500 }}>
                  {data.kyc.status === "PENDING" ? "View documents" : "Verify now"}
                </a>
              </div>
            ) : null}
            <div className="r-card r-pad" style={{ flex: 1 }}>
              <div className="r-label" style={{ marginBottom: 14 }}>Trade on</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 13 }}>
                {/* the installer itself: a full page load, never a client-side navigation */}
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>Desktop terminal</span><a href="/download/terminal/installer" style={{ fontSize: 12.5, fontWeight: 500 }}>Download</a></div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>WebTrader</span><a href="/api/room/webtrader" target="_blank" rel="noopener" style={{ fontSize: 12.5, fontWeight: 500 }}>Open</a></div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>Mobile app</span><a href="/room/downloads" style={{ fontSize: 12.5, fontWeight: 500 }}>Get the app</a></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {drawer ? <AccountDrawer key={drawer.id} account={drawer} lev={levOf(drawer.id)} onClose={() => setDrawerId("")} onChanged={changed} /> : null}
    </>
  );
}
