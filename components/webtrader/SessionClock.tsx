"use client";

import { useEffect, useState } from "react";

// Standard forex session hours in UTC — approximate, doesn't account for
// regional DST shifts (those move session open/close by ~1h a few weeks a
// year), which is the same simplification most retail platforms make for
// a glance-value indicator like this.
const SESSIONS = [
  { name: "Sydney", start: 22, end: 7 },
  { name: "Tokyo", start: 0, end: 9 },
  { name: "London", start: 8, end: 17 },
  { name: "New York", start: 13, end: 22 },
];

function isActive(hourUtc: number, start: number, end: number) {
  return start < end ? hourUtc >= start && hourUtc < end : hourUtc >= start || hourUtc < end;
}

// hideLabel -- WebTrader.tsx now wraps this in its own CollapsibleSection
// (title "Trading sessions"), which owns the header; this own internal
// label would just duplicate it. Still renders the live UTC clock inline
// on the border-top row (the collapsible header shows a static title
// only) when hidden -- see the border-top row just below.
export default function SessionClock({ hideLabel = false }: { hideLabel?: boolean }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (!now) return null;
  const hourUtc = now.getUTCHours();

  return (
    <div style={hideLabel ? { display: "flex", flexDirection: "column", gap: 6 } : { display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderTop: "1px solid var(--border)", marginTop: 10 }}>
      {hideLabel ? (
        <span className="field-label" style={{ padding: 0 }}>UTC {hourUtc.toString().padStart(2, "0")}:{now.getUTCMinutes().toString().padStart(2, "0")}</span>
      ) : (
        <span className="field-label">Trading sessions (UTC {hourUtc.toString().padStart(2, "0")}:{now.getUTCMinutes().toString().padStart(2, "0")})</span>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {SESSIONS.map((s) => {
          const active = isActive(hourUtc, s.start, s.end);
          return (
            <span
              key={s.name}
              style={{
                fontSize: 10.5,
                padding: "3px 8px",
                borderRadius: 5,
                background: active ? "var(--buy-bg)" : "var(--bg-3)",
                color: active ? "var(--buy)" : "var(--text-3)",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: active ? "var(--buy)" : "var(--text-3)" }} />
              {s.name}
            </span>
          );
        })}
      </div>
    </div>
  );
}
