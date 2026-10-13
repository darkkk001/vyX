// Shared fixtures for the QoreTrader demo's tests (not a test file). Every test file runs against its own throwaway clone of
// the local test database (vitest.global.isolated-db.ts), so these write freely.
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { seedQoreDemo, SUBDOMAIN } from "@/scripts/seed-qoredemo";
import { resetDemoBrokerCache } from "@/lib/demo";
import { getRedis } from "@/lib/redis";

export const D = (v: string | number) => new Prisma.Decimal(v);

/** Turns the demo tenant on and creates it with the real seed (apply). */
export async function seedDemoTenant() {
  process.env.DEMO_BROKER_SUBDOMAIN = SUBDOMAIN;
  resetDemoBrokerCache();
  await prisma.$transaction((tx) => seedQoreDemo(tx, { apply: true }), { timeout: 120_000, maxWait: 30_000 });
  const broker = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
  const group = await prisma.group.findFirstOrThrow({ where: { brokerId: broker.id, isDefault: true } });
  return { broker, group };
}

/** An ordinary broker with one real-looking symbol, one group and one funded LIVE account. */
export async function createOtherBroker(opts: { accountNumber?: string } = {}) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Other Corp ${suffix}`, subdomain: `other-${suffix}` } });
  const symbol = await prisma.symbol.create({ data: { name: `OT${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01) } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `OG-${suffix}`, isDefault: true } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: opts.accountNumber ?? `7${suffix.slice(0, 7)}`, email: `other-${suffix}@test.local`, passwordHash: "x", fullName: "Other client", accountMode: "LIVE", balance: D(5000) },
  });
  return { broker, symbol, group, account };
}

/** Removes the Redis keys a demo test may leave behind (only the demo's own prefixes). */
export async function cleanDemoRedis(prefixes: string[] = ["ratelimit:demo-guest", "demo:acct:", "demo:lock:"]) {
  const redis = getRedis();
  for (const p of prefixes) {
    const keys = await redis.keys(`${p}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}
