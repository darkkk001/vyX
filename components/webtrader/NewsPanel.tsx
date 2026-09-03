"use client";

import type { CalendarEvent } from "@/lib/economic-calendar";

const IMPACT_COLOR: Record<string, string> = {
  high: "var(--sell)",
  medium: "#F0B90B",
  low: "var(--text-3)",
};

// Impression Pack #3 -- events/unavailable lifted up to WebTrader.tsx
// (single shared fetch, since the chart markers and order-ticket warning
// chip need the exact same data, not a second independent poll of the
// same Finnhub-backed route).
// hideLabel -- WebTrader.tsx now wraps this in its own CollapsibleSection
// (title "Economic calendar"), which owns the header; this own internal
// label would just duplicate it.
export default function NewsPanel({ events, unavailable, hideLabel = false }: { events: CalendarEvent[] | null; unavailable: boolean; hideLabel?: boolean }) {
  return (
    <div style={hideLabel ? { display: "flex", flexDirection: "column", gap: 6 } : { display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid var(--border)", marginTop: 10 }}>
      {hideLabel ? null : <span className="field-label">Economic calendar</span>}
      {unavailable ? (
        <div className="net-pos-detail" style={{ fontSize: 11 }}>News feed unavailable right now.</div>
      ) : events === null ? (
        <div className="net-pos-detail" style={{ fontSize: 11 }}>Loading…</div>
      ) : events.length === 0 ? (
        <div className="net-pos-detail" style={{ fontSize: 11 }}>No upcoming events.</div>
      ) : (
        <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
          {events.map((e, i) => (
            <div key={i} style={{ fontSize: 10.5, display: "flex", flexDirection: "column", gap: 1, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: IMPACT_COLOR[e.impact?.toLowerCase()] ?? "var(--text-3)", flexShrink: 0 }} />
                <span className="mono" style={{ color: "var(--text-3)" }}>{e.time ? new Date(e.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span>
                <span style={{ color: "var(--text-3)" }}>{e.country}</span>
              </div>
              <div style={{ color: "var(--text-2)" }}>{e.event}</div>
              {(e.actual != null || e.estimate != null || e.previous != null) ? (
                <div className="mono" style={{ color: "var(--text-3)" }}>
                  {e.actual != null ? `A: ${e.actual} ` : ""}
                  {e.estimate != null ? `F: ${e.estimate} ` : ""}
                  {e.previous != null ? `P: ${e.previous}` : ""}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
