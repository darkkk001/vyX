import "server-only";
import crypto from "node:crypto";
import { getRedis } from "@/lib/redis";

// TOTP (RFC 6238, on top of RFC 4226's HOTP) implemented directly on
// Node's built-in crypto rather than pulling in a library -- the
// algorithm itself is ~30 lines of HMAC-SHA1 + dynamic truncation, and
// this codebase already prefers that (see lib/sso.ts's token handling)
// over a dependency for something this small and security-sensitive
// (fewer places to audit).

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 20 random bytes (160 bits) -- the size every authenticator app expects
// for a SHA1-based TOTP secret (RFC 4226 recommends at least 128 bits,
// 160 is the conventional default Google Authenticator/Authy etc. use).
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter % 2 ** 32, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

// Accepts the current 30s step and one step either side (±30s of clock
// drift between server and the trader's phone) -- the standard tolerance
// window, matching every mainstream TOTP implementation.
export function verifyTotp(secret: string, code: string, windowSteps = 1): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;

  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -windowSteps; errorWindow <= windowSteps; errorWindow++) {
    // Constant-time compare -- this is a shared secret's derived proof,
    // same class of value as a password, not something to leak via a
    // timing side-channel across the 6-digit space.
    const expected = hotp(secret, counter + errorWindow);
    if (
      expected.length === trimmed.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))
    ) {
      return true;
    }
  }
  return false;
}

const PENDING_CHALLENGE_TTL_SECONDS = 5 * 60;
function pendingChallengeKey(token: string) {
  return `pending_2fa:${token}`;
}

export type Pending2faPayload = { accountId: string; brokerId: string };

// The gap between "password checked out" and "session actually created"
// for an account with 2FA enabled -- app/api/trade/login and
// app/api/trade/login-redirect both issue one of these instead of a real
// session the moment the password matches, and POST
// /api/trade/login/verify-2fa is the only thing that can turn it into
// one. Deliberately NOT accepted by the SSO handoff
// (app/(broker)/trade/sso) -- that path's trust model is the broker's own
// portal vouching for the trader via a shared secret, not the trader's
// own password, so a local TOTP secret the broker's system never sees
// doesn't apply there.
export async function issuePending2faChallenge(payload: Pending2faPayload): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(pendingChallengeKey(token), JSON.stringify(payload), "EX", PENDING_CHALLENGE_TTL_SECONDS);
  return token;
}

// A peek, not a consume -- unlike lib/sso.ts's single-use token, a wrong
// code here (a typo, a stale code from switching apps) should let the
// trader just try again within the TTL rather than having to restart
// login from the password step. POST /api/trade/login/verify-2fa is what
// actually deletes this, and only once the code checks out -- see
// deletePending2faChallenge.
export async function peekPending2faChallenge(token: string): Promise<Pending2faPayload | null> {
  const raw = await getRedis().get(pendingChallengeKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending2faPayload;
  } catch {
    return null;
  }
}

export async function deletePending2faChallenge(token: string): Promise<void> {
  await getRedis().del(pendingChallengeKey(token));
}

const PENDING_ADMIN_CHALLENGE_TTL_SECONDS = 5 * 60;
function pendingAdminChallengeKey(token: string) {
  return `pending_admin_2fa:${token}`;
}

export type PendingAdmin2faPayload = { adminId: string };

// Same gap-bridging pattern as issuePending2faChallenge above, scoped to
// AdminUser instead of Account -- app/api/admin/login issues one of
// these instead of a real session once the Super Admin's password
// checks out, if twoFactorEnabled is set. Separate Redis key namespace
// so a leaked/guessed trader pending-token can never be replayed here.
export async function issuePendingAdmin2faChallenge(payload: PendingAdmin2faPayload): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(pendingAdminChallengeKey(token), JSON.stringify(payload), "EX", PENDING_ADMIN_CHALLENGE_TTL_SECONDS);
  return token;
}

export async function peekPendingAdmin2faChallenge(token: string): Promise<PendingAdmin2faPayload | null> {
  const raw = await getRedis().get(pendingAdminChallengeKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAdmin2faPayload;
  } catch {
    return null;
  }
}

export async function deletePendingAdmin2faChallenge(token: string): Promise<void> {
  await getRedis().del(pendingAdminChallengeKey(token));
}

// otpauth:// URI -- what a QR code encodes. `label` should be unique per
// credential so an authenticator app can tell multiple accounts apart
// (accountNumber, not email, since one email can have multiple Accounts
// under the same broker -- see docs/webtrader-stm-architecture-review.md
// §2.7).
export function totpUri(secret: string, accountNumber: string, issuer = "VyXTrader"): string {
  const label = encodeURIComponent(`${issuer}:${accountNumber}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
