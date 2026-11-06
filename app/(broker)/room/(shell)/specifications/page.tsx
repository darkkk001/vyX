"use client";

import { useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";

// Contract specifications: per plan, per symbol, from GET /api/room/specifications. Linked under the plan cards on Accounts.
type Row = { symbol: string; category: string; spreadPips: string | null; commissionPerLot: string | null; contractSize: string; hours: string };
type Plan = { name: string; rows: Row[] };
const REFRESH_MS = 15_000;

export default function RoomSpecifications() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await fetch("/api/room/specifications", { cache: "no-store" });
      if (res.ok && live) setPlans((await res.json()).plans);
    };
    void load();
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  const plan = plans?.find((p) => p.name === name) ?? plans?.[0] ?? null;
  return (
    <>
      <RoomHeader title="Contract specifications" picker={false} />
      <div className="r-body" style={{ gap: 16 }}>
        {plans && plans.length > 1 ? (
          <div role="tablist" aria-label="Plan" style={{ display: "inline-flex", alignSelf: "flex-start", background: "var(--r-card-2)", border: "1px solid var(--r-input)", borderRadius: 7, padding: 3 }}>
            {plans.map((p) => (
              <button key={p.name} type="button" role="tab" aria-selected={plan?.name === p.name} onClick={() => setName(p.name)}
                style={{ background: plan?.name === p.name ? "var(--r-accent)" : "none", color: plan?.name === p.name ? "var(--r-on-accent)" : "var(--r-text-2)", border: "none", borderRadius: 5, fontSize: 12.5, fontWeight: plan?.name === p.name ? 600 : 500, padding: "7px 18px", cursor: "pointer" }}>{p.name}</button>
            ))}
          </div>
        ) : null}
        {plans && plans.length === 0 ? <div className="r-card r-pad r-note">No plans are open right now.</div> : null}
        {plan ? (
          <div className="r-card r-table-wrap">
            <table className="r-table">
              <thead><tr><th>SYMBOL</th><th style={{ textAlign: "right" }}>LIVE SPREAD (PIPS)</th><th style={{ textAlign: "right" }}>COMMISSION / LOT</th><th style={{ textAlign: "right" }}>CONTRACT SIZE</th><th>TRADING HOURS</th></tr></thead>
              <tbody>
                {plan.rows.map((r) => (
                  <tr key={r.symbol}>
                    <td className="mono" style={{ fontWeight: 600 }}>{r.symbol}</td>
                    <td className="num">{r.spreadPips ?? "No quote"}</td>
                    <td className="num">{r.commissionPerLot ?? "None"}</td>
                    <td className="num">{Number(r.contractSize).toLocaleString("en-US")}</td>
                    <td style={{ color: "var(--r-text-2)" }}>{r.hours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div style={{ fontSize: 11.5, color: "var(--r-muted)", lineHeight: 1.6 }}>The spread is live and changes with the market. Commission is charged per lot when a position opens.</div>
      </div>
    </>
  );
}
