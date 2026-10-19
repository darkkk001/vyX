// FIX 4.4 wire codec: build a message (BodyLength + CheckSum computed here), and split an inbound byte stream
// into whole messages. Only what the cTrader QUOTE session needs; no dictionary, tags stay numeric.

export const SOH = "\x01";

export type Field = [tag: number, value: string];

export interface FixMessage {
  type: string;
  fields: Field[];
  // First value of a tag. Repeating-group tags (269, 270, 55 inside 35=W/X, ...) are read from `fields` in order.
  get(tag: number): string | undefined;
}

export function checksum(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return String(sum % 256).padStart(3, "0");
}

// UTCTimestamp with milliseconds: YYYYMMDD-HH:MM:SS.sss
export function fixTime(ms: number = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

export function parseFixTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return undefined;
  const ms = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}

// `body` is every field after 9=BodyLength except 10=CheckSum, starting with 35=MsgType.
export function encode(body: Field[], beginString = "FIX.4.4"): string {
  const inner = body.map(([t, v]) => `${t}=${v}${SOH}`).join("");
  const head = `8=${beginString}${SOH}9=${Buffer.byteLength(inner, "latin1")}${SOH}`;
  return `${head}${inner}10=${checksum(head + inner)}${SOH}`;
}

export function decode(raw: string): FixMessage {
  const fields: Field[] = [];
  for (const part of raw.split(SOH)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields.push([Number(part.slice(0, eq)), part.slice(eq + 1)]);
  }
  const get = (tag: number) => fields.find((f) => f[0] === tag)?.[1];
  return { type: get(35) ?? "", fields, get };
}

// For logs: the password (554) never leaves this process, and SOH reads as "|".
export function redact(raw: string): string {
  return raw.replace(/(^|\x01)554=[^\x01]*/g, "$1554=***").split(SOH).join("|");
}

// Accumulates socket bytes and yields complete, checksum-valid messages. A message with a bad checksum or a
// malformed header is reported through onError and skipped, never half-parsed.
export class FixStreamParser {
  private buf = "";
  private readonly onError: (reason: string) => void;

  constructor(onError: (reason: string) => void = () => {}) {
    this.onError = onError;
  }

  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("latin1");
    const out: string[] = [];
    for (;;) {
      const start = this.buf.indexOf("8=FIX");
      if (start < 0) {
        this.buf = "";
        return out;
      }
      if (start > 0) {
        this.onError(`discarded ${start} bytes before BeginString`);
        this.buf = this.buf.slice(start);
      }
      const lenTag = this.buf.indexOf(`${SOH}9=`);
      if (lenTag < 0) return out;
      const lenEnd = this.buf.indexOf(SOH, lenTag + 3);
      if (lenEnd < 0) return out;
      const bodyLen = Number(this.buf.slice(lenTag + 3, lenEnd));
      if (!Number.isInteger(bodyLen) || bodyLen <= 0) {
        this.onError("bad BodyLength");
        this.buf = this.buf.slice(lenEnd);
        continue;
      }
      const bodyStart = lenEnd + 1;
      const trailerStart = bodyStart + bodyLen;
      // 10=NNN<SOH> is 7 bytes
      if (this.buf.length < trailerStart + 7) return out;
      const trailer = this.buf.slice(trailerStart, trailerStart + 7);
      const msg = this.buf.slice(0, trailerStart + 7);
      this.buf = this.buf.slice(trailerStart + 7);
      if (!/^10=\d{3}\x01$/.test(trailer)) {
        this.onError("missing CheckSum where BodyLength says it is");
        continue;
      }
      if (checksum(msg.slice(0, trailerStart)) !== trailer.slice(3, 6)) {
        this.onError("CheckSum mismatch");
        continue;
      }
      out.push(msg);
    }
  }
}
