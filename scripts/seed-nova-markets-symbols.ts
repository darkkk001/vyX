// Nova Markets is the platform's demo/showcase tenant -- it should look
// like a complete broker, not one stuck on the original 10-symbol seed
// (prisma/seed.ts) while Futurix Global (the real, actively-configured
// broker) has grown to 30 enabled symbols through the backoffice Symbols
// page. Copies every ENABLED BrokerSymbol Futurix has -- including its
// real spread/lot/swap/commission config, not just the bare symbol --
// onto Nova Markets.
//
// Guarded inserts, same convention as prisma/seed.ts's own upsert loop:
// `update: {}` means an already-existing BrokerSymbol row on Nova Markets
// is left exactly as it is (never clobbers a config someone's already
// tuned there); only symbols Nova Markets doesn't have yet get created.
// Safe to re-run any time Futurix enables another symbol.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const [source, target] = await Promise.all([
    prisma.broker.findFirst({ where: { name: "Futurix Global" } }),
    prisma.broker.findFirst({ where: { name: "Nova Markets" } }),
  ]);
  if (!source) throw new Error("Futurix Global broker not found");
  if (!target) throw new Error("Nova Markets broker not found");

  const sourceSymbols = await prisma.brokerSymbol.findMany({
    where: { brokerId: source.id, enabled: true },
    include: { symbol: true },
  });
  console.log(`Futurix Global: ${sourceSymbols.length} enabled symbol(s)`);

  let created = 0;
  let alreadyPresent = 0;
  for (const bs of sourceSymbols) {
    const existing = await prisma.brokerSymbol.findUnique({
      where: { brokerId_symbolId: { brokerId: target.id, symbolId: bs.symbolId } },
    });
    await prisma.brokerSymbol.upsert({
      where: { brokerId_symbolId: { brokerId: target.id, symbolId: bs.symbolId } },
      update: {},
      create: {
        brokerId: target.id,
        symbolId: bs.symbolId,
        spreadMarkup: bs.spreadMarkup,
        minLot: bs.minLot,
        maxLot: bs.maxLot,
        lotStep: bs.lotStep,
        swapLong: bs.swapLong,
        swapShort: bs.swapShort,
        commissionPerLot: bs.commissionPerLot,
        maxExposure: bs.maxExposure,
        defaultBookType: bs.defaultBookType,
        tradingMode: bs.tradingMode,
        enabled: true,
      },
    });
    if (existing) {
      alreadyPresent += 1;
    } else {
      created += 1;
      console.log(`  + ${bs.symbol.name}`);
    }
  }

  const finalCount = await prisma.brokerSymbol.count({ where: { brokerId: target.id, enabled: true } });
  console.log(`\nCreated       : ${created}`);
  console.log(`Already present: ${alreadyPresent}`);
  console.log(`Nova Markets enabled symbol total: ${finalCount}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
