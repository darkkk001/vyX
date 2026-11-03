// Trader's Room number and date formats. Money: thousands separators, 2 dp, a minus sign only (never "+"), colour by
// sign through the profit / loss classes (profit blue, loss red). Dates in the viewer's own time zone.

export function money(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n)) return "0.00";
  const r = Math.round(n * 100) / 100;
  const s = Math.abs(r).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return r < 0 ? `-${s}` : s;
}

/** profit / loss class for a P/L figure, "" at zero */
export function pnlClass(v: string | number | null | undefined): string {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return "";
  return n > 0 ? "profit" : "loss";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "03 Nov 2026" */
export function day(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
/** "03 Nov" */
export function dayShort(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]}`;
}
/** "03 Nov 2026, 21:14" */
export function dayTime(iso: string): string {
  const d = new Date(iso);
  return `${day(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** "03 Nov 2026 10:12" (tables) */
export function dayTimeCompact(iso: string): string {
  const d = new Date(iso);
  return `${day(iso)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
