import "server-only";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { demoSubdomain, GUEST_NUMBER_MAX, GUEST_NUMBER_MIN, isGuestAccountNumber } from "@/lib/demo-policy";
import { assertAccountStructure } from "@/lib/account-structure";

// QoreTrader demo tenant, server side: who the demo broker is, how a guest account is made, and the Redis state the lazy
// SL/TP sweep keeps per guest. The tenant is marked by DEMO_BROKER_SUBDOMAIN (lib/demo-policy.ts); no schema change.

// ---- the reserved range of guest account numbers (lib/demo-policy.ts) ----
export { GUEST_NUMBER_MIN, GUEST_NUMBER_MAX, isGuestAccountNumber };

// ---- limits (owner decisions 2026-10-12) ----
export const GUEST_START_BALANCE = "10000";
export const GUEST_PER_IP_PER_HOUR = 3;
/** a sane global ceiling on new guests per hour, whatever the number of addresses */
export const GUEST_GLOBAL_PER_HOUR = 300;
export const GUEST_IDLE_DAYS = 7;
export const GUEST_MAX_AGE_DAYS = 30;
export const DEMO_STATE_TTL_SECONDS = 32 * 24 * 3600;

// ---- who is the demo broker ----
type DemoBrokerCache = { id: string | null; at: number };
let demoBrokerCache: DemoBrokerCache | null = null;
const FOUND_TTL_MS = 10 * 60_000;
const MISSING_TTL_MS = 30_000;

/** Test hook: forget the cached lookup. */
export function resetDemoBrokerCache(): void {
  demoBrokerCache = null;
  sandboxCache.clear();
}

/** The demo broker's id, or null when no demo tenant is configured or its row does not exist. Cached per process. */
export async function getDemoBrokerId(db: Pick<PrismaClient, "broker"> = prisma): Promise<string | null> {
  const sub = demoSubdomain();
  if (!sub) return null;
  const now = Date.now();
  if (demoBrokerCache && now - demoBrokerCache.at < (demoBrokerCache.id ? FOUND_TTL_MS : MISSING_TTL_MS)) return demoBrokerCache.id;
  const row = await db.broker.findUnique({ where: { subdomain: sub }, select: { id: true } });
  demoBrokerCache = { id: row?.id ?? null, at: now };
  return demoBrokerCache.id;
}

// Is this broker a sandbox tenant? Read from Broker.isDemoSandbox (not from the environment variable), cached per process:
// a sandbox flag does not flip at run time, and every event publisher and follow-through asks.
const sandboxCache = new Map<string, { v: boolean; at: number }>();
const SANDBOX_TTL_MS = 5 * 60_000;
export function resetSandboxCache(): void {
  sandboxCache.clear();
}
export async function isDemoBrokerId(brokerId: string | null | undefined): Promise<boolean> {
  if (!brokerId) return false;
  const hit = sandboxCache.get(brokerId);
  const now = Date.now();
  if (hit && now - hit.at < SANDBOX_TTL_MS) return hit.v;
  const row = await prisma.broker.findUnique({ where: { id: brokerId }, select: { isDemoSandbox: true } });
  const v = row?.isDemoSandbox === true;
  sandboxCache.set(brokerId, { v, at: now });
  return v;
}

// ---- the client address a rate limit counts ----
/**
 * The visitor's address for the guest rate limit. Vercel's edge sets x-real-ip (the header @vercel/functions ipAddress()
 * reads) and x-vercel-forwarded-for from the connecting peer and overwrites any value the client sent, so they cannot be
 * spoofed on Vercel. x-forwarded-for is NOT used: its first hop is whatever the client put there anywhere that is not behind
 * such a proxy. No trusted header = "unknown", one shared bucket (it fails safe). IPv6 counts per /64 so rotating the host
 * part of one prefix buys nothing.
 */
export function clientIpOf(h: { get(name: string): string | null }): string {
  const raw = (h.get("x-real-ip") ?? h.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  if (!raw) return "unknown";
  if (raw.includes(":")) {
    const groups = raw.toLowerCase().split("::")[0].split(":").filter((g) => g !== "");
    return `v6:${groups.slice(0, 4).join(":")}`;
  }
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : "unknown";
}

// ---- Redis state per guest: the lazy sweep's cursor ----
export type DemoAccountState = { t: number; w: 0 | 1 };
const stateKey = (accountId: string) => `demo:acct:${accountId}`;
const lockKey = (accountId: string) => `demo:lock:${accountId}`;

export async function readDemoState(accountId: string): Promise<DemoAccountState | null> {
  const raw = await getRedis().get(stateKey(accountId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as DemoAccountState;
    return typeof v.t === "number" ? { t: v.t, w: v.w ? 1 : 0 } : null;
  } catch {
    return null;
  }
}
export async function writeDemoState(accountId: string, s: DemoAccountState): Promise<void> {
  await getRedis().set(stateKey(accountId), JSON.stringify(s), "EX", DEMO_STATE_TTL_SECONDS);
}
/** An order or a pending order was just placed: the next request sweeps this account. */
export async function markDemoWork(accountId: string): Promise<void> {
  const cur = await readDemoState(accountId);
  await writeDemoState(accountId, { t: cur?.t ?? 0, w: 1 });
}
export async function clearDemoState(accountId: string): Promise<void> {
  await getRedis().del(stateKey(accountId), lockKey(accountId));
}
export async function acquireSweepLock(accountId: string): Promise<boolean> {
  return (await getRedis().set(lockKey(accountId), "1", "EX", 20, "NX")) === "OK";
}
export async function releaseSweepLock(accountId: string): Promise<void> {
  await getRedis().del(lockKey(accountId));
}

// ---- guest account creation ----
export class GuestRangeFull extends Error {}

/**
 * The next free number in the guest range: MAX inside the range + 1. When the top of the range is reached, a random free
 * number inside it; never a number outside it. Collision-safe by the unique index on Account.accountNumber: the caller
 * retries on P2002.
 */
export async function nextGuestNumber(db: Pick<PrismaClient, "$queryRaw">): Promise<string> {
  const rows = await db.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX("accountNumber"::bigint) AS max FROM "Account" WHERE "accountNumber" ~ '^48[0-9]{6}$'
  `;
  const max = rows[0]?.max != null ? Number(rows[0].max) : GUEST_NUMBER_MIN - 1;
  if (max < GUEST_NUMBER_MAX) return String(Math.max(max + 1, GUEST_NUMBER_MIN));
  // top of the range reached: a random number inside it (a taken one is a P2002 and the caller retries)
  return String(GUEST_NUMBER_MIN + crypto.randomInt(0, GUEST_NUMBER_MAX - GUEST_NUMBER_MIN + 1));
}

export type GuestAccount = { id: string; accountNumber: string; brokerId: string };

/**
 * Creates one guest account on the demo broker: DEMO mode, the broker's default group, 10,000 USD (ADJUSTMENT row), a
 * guest e-mail, an unusable password, no client. Returns null when the demo broker or its default group is missing.
 */
export async function createGuestAccount(db: PrismaClient = prisma): Promise<GuestAccount | null> {
  const brokerId = await getDemoBrokerId(db);
  if (!brokerId) return null;
  const broker = await db.broker.findUnique({ where: { id: brokerId }, select: { id: true, status: true, defaultAccountCurrency: true, defaultAccountLeverage: true } });
  if (!broker || broker.status !== "ACTIVE") return null;
  const group = await db.group.findFirst({ where: { brokerId, isDefault: true }, select: { id: true, category: true, modeRestriction: true, leverage: true } });
  if (!group) return null;
  assertAccountStructure({ accountMode: "DEMO", group, allowCoverage: false });
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 4); // nobody knows it; the demo host has no password sign-in

  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const accountNumber = await nextGuestNumber(db);
    if (!isGuestAccountNumber(accountNumber)) throw new GuestRangeFull("guest number outside the reserved range");
    try {
      return await db.$transaction(async (tx) => {
        const account = await tx.account.create({
          data: {
            brokerId,
            accountNumber,
            email: `guest-${accountNumber}@demo.invalid`,
            passwordHash,
            fullName: "Demo trader",
            accountMode: "DEMO",
            accountTypeId: null,
            currency: broker.defaultAccountCurrency || "USD",
            leverage: group.leverage || broker.defaultAccountLeverage || 100,
            groupId: group.id,
            clientId: null,
            balance: new Prisma.Decimal(GUEST_START_BALANCE),
          },
        });
        await tx.transaction.create({
          data: {
            brokerId,
            accountId: account.id,
            type: "ADJUSTMENT",
            status: "COMPLETED",
            amount: new Prisma.Decimal(GUEST_START_BALANCE),
            balanceBefore: new Prisma.Decimal(0),
            balanceAfter: new Prisma.Decimal(GUEST_START_BALANCE),
            note: "Initial balance on account creation",
          },
        });
        await tx.auditLog.create({
          data: {
            brokerId,
            action: "ACCOUNT_CREATED",
            entityType: "Account",
            entityId: account.id,
            oldValue: Prisma.JsonNull,
            newValue: { accountNumber, accountMode: "DEMO", initialBalance: GUEST_START_BALANCE, guest: true },
          },
        });
        return { id: account.id, accountNumber, brokerId };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt < MAX_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new GuestRangeFull("could not find a free guest number");
}
