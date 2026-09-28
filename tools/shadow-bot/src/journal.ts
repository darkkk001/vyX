// One JSON object per line, per run: logs/run-<UTC>.jsonl. Every line has the UTC time (to line up against
// shadow_pair) and a monotonic ms (ordering inside the run). Secrets and cookies are never written.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type JournalEvent = Record<string, unknown> & { kind: string };

export class Journal {
  readonly file: string;
  private readonly t0 = performance.now();
  constructor(dir: string, readonly runId: string, private readonly echo: (line: string) => void = (l) => console.log(l)) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `run-${runId}.jsonl`);
  }
  write(ev: JournalEvent): void {
    const line = { t: new Date().toISOString(), mono_ms: Math.round(performance.now() - this.t0), run: this.runId, ...ev };
    const text = JSON.stringify(line, (k, v) => (/secret|cookie|password/i.test(k) ? "[redacted]" : v));
    appendFileSync(this.file, text + "\n");
    this.echo(`${line.t}  ${ev.kind.padEnd(16)} ${summarize(ev)}`);
  }
}

function summarize(ev: JournalEvent): string {
  return Object.entries(ev)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
}
