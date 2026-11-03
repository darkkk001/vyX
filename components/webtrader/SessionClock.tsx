"use client";

import { useEffect, useState } from "react";
import { sessionRows } from "@/lib/session-rows";

// The SESSIONS section of the right column, laid out like the native terminal: one row per session, OPEN in the status
// green, otherwise the UTC time it opens and the wait. The section header (WebTrader.tsx) carries the UTC clock.
// Open vs closed is also said in words (OPEN / a time), so colour is never the only signal.
export default function SessionClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  if (!now) return null;
  return (
    <div className="nt-rows">
      {sessionRows(now).map((s) => (
        <div key={s.name} className="nt-row" title={`${s.name} session: ${s.open ? "open" : `opens ${s.opensAt} UTC`}`}>
          <span className="nt-row-label">{s.name}</span>
          {s.open ? <span className="nt-row-value nt-open">OPEN</span> : <span className="nt-row-value mono nt-dim">{s.opensAt} · {s.opensIn}</span>}
        </div>
      ))}
    </div>
  );
}
