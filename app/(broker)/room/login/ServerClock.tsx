"use client";

import { useEffect, useState } from "react";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const two = (n: number) => String(n).padStart(2, "0");

/** "03 NOV 2026 · 14:29 UTC", ticking each minute (rendered after mount so server and browser never disagree). */
export default function ServerClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <span />;
  return <span>{`${two(now.getUTCDate())} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} · ${two(now.getUTCHours())}:${two(now.getUTCMinutes())} UTC`}</span>;
}
