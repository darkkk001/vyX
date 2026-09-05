// Minimal CSV writer -- no dependency needed for the handful of flat
// export shapes Reports produces. Quotes any field containing a comma,
// quote, or newline; doubles embedded quotes (RFC 4180).
export function toCsv(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  function cell(value: unknown): string {
    let s = value == null ? "" : String(value);
    // CSV/formula injection fix (2026-09-05, security audit finding) --
    // a cell whose TEXT starts with =, +, -, @, tab, or CR is interpreted
    // as a live formula by Excel/Sheets/LibreOffice on open, regardless of
    // this being a CSV rather than a native spreadsheet file. Confirmed
    // exploitable live: a trader's own funds-request note (financial
    // report) and an account's fullName (client report) both reach this
    // function unsanitized. Prepending a single quote is the standard
    // OWASP-recommended neutralizer -- every affected app opens the cell
    // as literal text instead, and the quote itself is invisible in the
    // rendered spreadsheet (Excel/Sheets both strip a leading apostrophe
    // used this way, same convention as forcing a text-formatted cell).
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const header = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => cell(row[c.key])).join(","));
  return [header, ...body].join("\r\n") + "\r\n";
}
