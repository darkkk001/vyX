import "server-only";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Staff sign-in hardening (owner 2026-11-13): 10 wrong passwords on one address lock it for 15 minutes, and a refusal
// for an unknown / wrong-role email still costs one bcrypt compare, so response time says nothing about who exists.
export const STAFF_LOGIN_FAILURES = 10;
export const STAFF_LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

let decoy: Promise<string> | null = null;
export async function staffDecoyCompare(password: string): Promise<void> {
  await bcrypt.compare(password, await (decoy ??= bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10)));
}
