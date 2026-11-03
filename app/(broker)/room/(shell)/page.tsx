"use client";

import RoomHeader from "@/components/room/RoomHeader";
import StatusChip from "@/components/room/StatusChip";
import { useRoom } from "@/components/room/RoomData";
import { money, pnlClass, dayShort, dayTime, greeting } from "@/components/room/format";

// Artboard "Dashboard": greeting, equity strip of the picked account, account cards, recent transactions,
// verification card, trade-on card.
const KYC_STATUS: Record<string, string> = { APPROVED: "Approved", PENDING: "Pending", REJECTED: "Rejected", NONE: "Not verified" };
const Check = ({ ok }: { ok: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke={ok ? "var(--r-ok)" : "var(--r-muted)"} strokeWidth="1.8" aria-hidden="true">
    {ok ? <path d="m2.5 7.5 3 3 6-6" /> : <circle cx="7" cy="7" r="4.5" />}
  </svg>
);

export default function RoomDashboard() {
  const { data, error, selected } = useRoom();
  const f = selected?.figures;
  const firstName = data?.client.fullName.split(/\s+/)[0] ?? "";
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
            <div className="r-label">My accounts</div>
            <a href="/room/accounts">Manage accounts</a>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14 }}>
            {(data?.accounts ?? []).map((a) => (
              <div key={a.id} className="r-card r-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className={`r-mode ${a.mode === "LIVE" ? "r-mode-live" : "r-mode-demo"}`}><span className="r-dot" />{a.mode}</span>
                  <span style={{ color: "var(--r-muted)", fontSize: 12 }}>{a.plan} · 1:{a.leverage}</span>
                </div>
                <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>{a.accountNumber}</div>
                <div style={{ display: "flex", gap: 20 }}>
                  <div><div className="r-label" style={{ fontSize: 10, letterSpacing: 1 }}>Balance</div><div className="mono" style={{ fontSize: 14.5, marginTop: 3 }}>{money(a.figures.balance)}</div></div>
                  <div><div className="r-label" style={{ fontSize: 10, letterSpacing: 1 }}>Equity</div><div className="mono" style={{ fontSize: 14.5, marginTop: 3 }}>{money(a.figures.equity)}</div></div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  {a.mode === "LIVE" ? <a className="r-btn r-btn-sm" style={{ flex: 1 }} href={`/room/deposit?account=${a.id}`}>Deposit</a> : null}
                  <a className="r-btn-ghost r-btn-sm" style={{ flex: 1 }} href="/room/downloads">Trade</a>
                </div>
              </div>
            ))}
            <a href="/room/accounts#open" style={{ border: "1px dashed var(--r-dash)", borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--r-text-2)", minHeight: 150 }}>
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M11 4v14M4 11h14" /></svg>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Open new account</span>
            </a>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <div className="r-card r-pad" style={{ flex: "2 1 480px", minWidth: 0 }}>
            <div className="r-sec-head" style={{ marginBottom: 14 }}>
              <div className="r-label">Recent transactions</div>
              <a href="/room/history">View all</a>
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
                  {(data?.recent ?? []).map((t) => (
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
              {data && data.recent.length === 0 ? <div className="r-empty">No transactions yet.</div> : null}
            </div>
          </div>

          <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="r-card r-pad">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div className="r-label">Verification</div>
                {data ? <StatusChip status={KYC_STATUS[data.kyc.status] ?? "Not verified"} /> : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Check ok={data?.kyc.status === "APPROVED" || false} />Identity document</div>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}><Check ok={data?.kyc.status === "APPROVED" && data.kyc.address} />Proof of address</div>
              </div>
              <a href={data?.kyc.status === "APPROVED" || data?.kyc.status === "PENDING" ? "/room/profile" : "/room/verify"} style={{ display: "inline-block", marginTop: 14, fontSize: 12.5, fontWeight: 500 }}>
                {data?.kyc.status === "APPROVED" || data?.kyc.status === "PENDING" ? "View documents" : "Verify now"}
              </a>
            </div>
            <div className="r-card r-pad">
              <div className="r-label" style={{ marginBottom: 14 }}>Trade on</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 11, fontSize: 13 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>Desktop terminal</span><a href="/room/downloads" style={{ fontSize: 12.5, fontWeight: 500 }}>Download</a></div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>WebTrader</span><a href="/room/downloads" style={{ fontSize: 12.5, fontWeight: 500 }}>Open</a></div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><span>Mobile app</span><a href="/room/downloads" style={{ fontSize: 12.5, fontWeight: 500 }}>Get the app</a></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
