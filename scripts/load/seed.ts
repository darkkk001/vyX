// Stage 4 load harness -- seeds one generated world (scripts/load/generate.ts) into a load database, wiping it first.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_load_web DIRECT_URL=<same> \
//   npx tsx --conditions=react-server scripts/load/seed.ts engine/parity/out/load/world-1-100.json
//
// Same rows as scripts/parity/run-ts.ts seeds for a scenario (broker, groups, accounts, symbols + BrokerSymbol,
// FILLED origin orders, positions, coverage links, mirror rules / links, LivePrice), in bulk, plus queued closes.
import "./env";
import fs from "node:fs";
import { assertLoadDb, LOAD_DB_NAME } from "./env";
import type { World } from "./generate";

export async function seedWorld(world: World) {
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");
  const D = (v: string | number) => new Prisma.Decimal(v);
  await assertLoadDb(prisma);

  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);

  for (const b of world.brokers) {
    await prisma.broker.create({ data: { id: b.id, name: `Load ${b.id}`, subdomain: b.id.toLowerCase().slice(0, 60), negativeBalanceProtection: b.nbp } });
  }
  await prisma.group.createMany({
    data: world.groups.map((g, i) => ({ id: g.id, brokerId: g.broker, name: g.id, isDefault: i === 0, marginCallLevel: D(g.marginCallLevel), stopOutLevel: D(g.stopOutLevel) })),
  });
  await prisma.account.createMany({
    data: world.accounts.map((a, i) => ({
      id: a.id, brokerId: a.broker, groupId: a.group, accountNumber: `8${String(i + 1).padStart(7, "0")}`, email: `${a.id}@load.local`, passwordHash: "x", fullName: `Load ${a.role}`,
      accountMode: "LIVE" as const, leverage: a.leverage, balance: D(a.balance), credit: D(a.credit), currency: a.currency,
    })),
  });
  for (const b of world.brokers) {
    if (b.coverageAccount) await prisma.broker.update({ where: { id: b.id }, data: { coverageAccountId: b.coverageAccount } });
  }

  // symbols are global; every broker lists every symbol (BrokerSymbol) so the session gate applies per broker as on the web
  const symbolIds = new Map<string, string>();
  for (const s of world.symbols) {
    // CRYPTO = continuously traded (see run-ts.ts): the result never depends on the weekday / hour of the run
    const row = await prisma.symbol.create({ data: { name: s.name, baseCurrency: s.name.slice(0, 3), quoteCurrency: s.quoteCurrency, digits: s.digits, contractSize: D(s.contractSize), category: "CRYPTO" as never } });
    symbolIds.set(s.name, row.id);
    for (const b of world.brokers) {
      const bs = await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: row.id } });
      if (s.sessionClosedNow) {
        const otherDay = (new Date().getUTCDay() + 3) % 7;
        await prisma.tradingSession.create({ data: { brokerSymbolId: bs.id, dayOfWeek: otherDay, openTime: "00:00", closeTime: "23:59" } });
      }
    }
  }

  const brokerOf = new Map(world.accounts.map((a) => [a.id, a.broker]));
  await prisma.order.createMany({
    data: world.positions.map((p) => ({
      id: `o-${p.id}`, brokerId: brokerOf.get(p.account)!, accountId: p.account, symbolId: symbolIds.get(p.symbol)!, side: p.side, type: "MARKET" as const,
      volume: D(p.volume), status: "FILLED" as const, filledPrice: D(p.openPrice), filledAt: new Date(), idempotencyKey: `load:${p.id}`,
    })),
  });
  // openedAt spaced 1 ms apart in world order: "oldest first" (SL/TP order, F5) is then the same on both sides
  const base = Date.now() - 3600_000;
  await prisma.position.createMany({
    data: world.positions.map((p, i) => ({
      id: p.id, brokerId: brokerOf.get(p.account)!, accountId: p.account, symbolId: symbolIds.get(p.symbol)!, originOrderId: `o-${p.id}`, side: p.side,
      volume: D(p.volume), openPrice: D(p.openPrice), slPrice: p.slPrice ? D(p.slPrice) : null, tpPrice: p.tpPrice ? D(p.tpPrice) : null,
      autoHedged: !!p.autoHedged, openedAt: new Date(base + i),
    })),
  });
  for (const p of world.positions) {
    if (p.coverageLeg) await prisma.position.update({ where: { id: p.id }, data: { covered: true, coveredAt: new Date(), coveragePositionId: p.coverageLeg } });
  }
  const queued = world.positions.filter((p) => p.queuedClose);
  if (queued.length) {
    await prisma.order.createMany({
      data: queued.map((p) => ({
        id: `q-${p.id}`, brokerId: brokerOf.get(p.account)!, accountId: p.account, symbolId: symbolIds.get(p.symbol)!, side: p.side, type: "MARKET" as const,
        volume: D(p.volume), status: "PENDING" as const, closesPositionId: p.id, closeVolume: D(p.volume), idempotencyKey: `load:q:${p.id}`,
      })),
    });
    for (const p of queued) await prisma.position.update({ where: { id: p.id }, data: { closePendingOrderId: `q-${p.id}` } });
  }

  const admins = new Map<string, string>();
  for (const m of world.mirrors) {
    if (!admins.has(m.broker)) {
      const admin = await prisma.adminUser.create({ data: { brokerId: m.broker, email: `admin@${m.broker.toLowerCase()}.load.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
      admins.set(m.broker, admin.id);
    }
    const groupId = world.groups.find((g) => g.broker === m.broker)!.id;
    await prisma.mirrorRule.create({
      data: { id: m.id, brokerId: m.broker, sourceType: "GROUP", sourceId: groupId, targetAccountId: m.master, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: m.fillPriceMode, createdById: admins.get(m.broker)! },
    });
    if (m.links.length) await prisma.mirrorLink.createMany({ data: m.links.map((l) => ({ ruleId: m.id, sourcePositionId: l.source, targetPositionId: l.target })) });
  }

  for (const px of world.prices) {
    await prisma.$executeRaw`
      INSERT INTO "LivePrice" (symbol, bid, ask, "tickAt", "updatedAt")
      VALUES (${px.symbol}, ${D(px.bid)}, ${D(px.ask)}, now() - make_interval(secs => ${px.ageSeconds}::double precision), now() - make_interval(secs => ${px.ageSeconds}::double precision))`;
  }
  console.log(`[load:seed] ${LOAD_DB_NAME}: ${world.accounts.length} accounts, ${world.positions.length} positions, ${queued.length} queued closes`);
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const world: World = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  seedWorld(world)
    .then(async () => (await import("@/lib/prisma")).prisma.$disconnect())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
