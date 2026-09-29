// RFC 6238 TOTP with the web's parameters (lib/totp.ts: HMAC-SHA1, 6 digits, 30 s step), so the read-only staff
// observer can complete its two-step sign-in. The secret is base32 (A-Z, 2-7, no padding), as the web stores it.
import { createHmac } from "node:crypto";

const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = A.indexOf(c);
    if (i < 0) throw new Error("the TOTP secret is not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The 6-digit code for the 30 s step containing `atMs`. */
export function totp(secret: string, atMs = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Milliseconds left in the current 30 s step (the observer waits for a fresh step when fewer than 3 s are left). */
export function msLeftInStep(atMs = Date.now()): number {
  return 30_000 - (atMs % 30_000);
}
