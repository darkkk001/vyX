"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";

type ReplayData = {
  position: {
    id: string;
    accountNumber: string;
    accountFullName: string;
    symbol: string;
    digits: number;
    side: "BUY" | "SELL";
    volume: string;
    openPrice: string;
    closePrice: string | null;
    openedAt: string;
    closedAt: string | null;
  };
  order: { id: string; type: string; requestedPrice: string | null; filledPrice: string | null; requotedPrice: string | null };
  candles: { time: string; open: string; high: string; low: string; close: string }[];
  auditEvents: { id: string; time: string; label: string; actor: string; diff: string[] }[];
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Impression Pack #5 -- Dealing Replay v1. Opened from any position/deal
// row via positionId; self-fetches from /api/manage/positions/[id]/replay.
// Deliberately labeled "reconstructed from 1-minute data" throughout --
// this app stores OHLC candles, not raw ticks, so this is a best-effort
// reconstruction, not a tick-accurate replay.
export default function DealingReplayPanel({ positionId, onClose }: { positionId: string; onClose: () => void }) {
  const [data, setData] = useState<ReplayData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/manage/positions/${positionId}/replay`)
      .then((r) => {
        if (!r.ok) throw new Error("failed to load replay data");
        return r.json();
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "failed to load"); });
    return () => { cancelled = true; };
  }, [positionId]);

  return (
    <Modal open onClose={onClose} title="Dealing Replay" wide>
      {error ? (
        <p className="text-sm text-[var(--sell)]">{error}</p>
      ) : !data ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">
            Reconstructed from 1-minute candle data -- not a tick-accurate replay (this platform stores OHLC bars, not raw ticks).
          </p>

          <div className="grid grid-cols-2 gap-2.5 text-sm">
            <div>
              <p className="text-[10.5px] uppercase text-[var(--text-3)]">Account</p>
              <p className="font-mono text-[var(--text-1)]">{data.position.accountNumber}</p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase text-[var(--text-3)]">Symbol / Side</p>
              <p className="text-[var(--text-1)]">
                {data.position.symbol} <Badge tone={data.position.side === "BUY" ? "success" : "danger"}>{data.position.side}</Badge>
              </p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase text-[var(--text-3)]">Requested / Filled price</p>
              <p className="font-mono text-[var(--text-1)]">
                {data.order.requestedPrice ?? "market"} → {data.order.filledPrice ?? "-"}
                {data.order.requotedPrice ? ` (requoted ${data.order.requotedPrice})` : ""}
              </p>
            </div>
            <div>
              <p className="text-[10.5px] uppercase text-[var(--text-3)]">Open / Close price</p>
              <p className="font-mono text-[var(--text-1)]">{data.position.openPrice} → {data.position.closePrice ?? "still open"}</p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
              M1 bars around the fill ({data.candles.length})
            </p>
            {data.candles.length === 0 ? (
              <p className="text-sm text-[var(--text-3)]">No M1 candle history available for this time range.</p>
            ) : (
              <div className="max-h-[180px] overflow-y-auto rounded-md border border-[var(--border)]">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[10px] uppercase text-[var(--text-3)]">
                      <th className="px-2 py-1 text-left">Time</th>
                      <th className="px-2 py-1 text-right">Open</th>
                      <th className="px-2 py-1 text-right">High</th>
                      <th className="px-2 py-1 text-right">Low</th>
                      <th className="px-2 py-1 text-right">Close</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candles.map((c) => (
                      <tr key={c.time} className="border-b border-[var(--border)] font-mono text-[var(--text-2)] last:border-0">
                        <td className="px-2 py-1">{fmtTime(c.time)}</td>
                        <td className="px-2 py-1 text-right">{c.open}</td>
                        <td className="px-2 py-1 text-right">{c.high}</td>
                        <td className="px-2 py-1 text-right">{c.low}</td>
                        <td className="px-2 py-1 text-right">{c.close}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Audit timeline</p>
            {data.auditEvents.length === 0 ? (
              <p className="text-sm text-[var(--text-3)]">No audit events recorded for this order/position.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {data.auditEvents.map((e) => (
                  <div key={e.id} className="rounded-md border border-[var(--border)] px-2.5 py-2 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[var(--text-1)]">{e.label}</span>
                      <span className="font-mono text-[var(--text-3)]">{fmtTime(e.time)}</span>
                    </div>
                    <div className="text-[var(--text-3)]">by {e.actor}</div>
                    {e.diff.length > 0 ? (
                      <ul className="mt-1 list-disc pl-4 text-[var(--text-2)]">
                        {e.diff.map((d, i) => <li key={i}>{d}</li>)}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
