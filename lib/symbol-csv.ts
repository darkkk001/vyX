// Symbols tab (backoffice 1.0.101): a small RFC 4180 CSV reader for the symbol import. Handles a leading BOM, CRLF / LF,
// quoted cells with commas, doubled quotes and line breaks inside quotes. Returns each record with its 1-based line number
// in the file (the line the record starts on), skipping fully blank lines.
export type CsvRecord = { line: number; cells: string[] };

export function parseCsv(text: string): CsvRecord[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let touched = false; // anything seen on this record (a quote, a char or a comma)
  const endRecord = () => {
    cells.push(cell);
    if (touched || cells.some((c) => c !== "")) out.push({ line: startLine, cells });
    cells = [];
    cell = "";
    touched = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      touched = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
      touched = true;
    } else if (ch === "\r") {
      // swallowed: the \n that follows ends the record
    } else if (ch === "\n") {
      endRecord();
      line++;
      startLine = line;
    } else {
      cell += ch;
      touched = true;
    }
  }
  if (cell !== "" || cells.length > 0 || touched) endRecord();
  return out;
}
