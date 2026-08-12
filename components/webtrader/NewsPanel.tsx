"use client";

import { useEffect, useState } from "react";

type NewsEvent = {
  time: string;
  country: string;
  event: string;
  impact: string;
  actual: string | number | null;
  estimate: string | number | null;
  previous: string | number | null;
};

const IMPACT_COLOR: Record<string, string> = {
  high: "var(--sell)",
  medium: "#F0B90B",
  low: "var(--text-3)",
};

export default function NewsPanel() {
  const [events, setEvents] = useState<NewsEvent[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/trade/news");
        if (cancelled) return;
        if (!res.ok) {
          setUnavailable(true);
          return;
        }
        setEvents(await res.json());
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    }
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid var(--border)", marginTop: 10 }}>
      <span className="field-label">Economic calendar</span>
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
