// Minimal CSV writer -- no dependency needed for the handful of flat
// export shapes Reports produces. Quotes any field containing a comma,
// quote, or newline; doubles embedded quotes (RFC 4180).
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  function cell(value: unknown): string {
    const s = value == null ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const header = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => cell(row[c.key])).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}
