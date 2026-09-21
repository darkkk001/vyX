/**
 * Gate for Stage 4 piece 6 (broker onboarding starter state).
 *
 * Run against a THROWAWAY scratch database only -- it creates and deletes
 * brokers. Never point DATABASE_URL at prod when running this.
 */
import { PrismaClient } from "@prisma/client";
import { provisionStarterState, STARTER_SYMBOLS, STARTER_GROUPS } from "../lib/starter-state";
import { provisionAccount } from "../lib/account-provisioning";

const prisma = new PrismaClient();
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1|localhost/.test(url)) {
    throw new Error("refusing to run: DATABASE_URL is not a local scratch database");
  }

  const sub = "gatebroker" + Date.now().toString().slice(-6);
  console.log("=== 1. provision a brand-new broker, exactly as the API does ===");
  const { broker, starter } = await prisma.$transaction(async (tx) => {
    const created = await tx.broker.create({
      data: { name: "Gate Broker", subdomain: sub, tier: "STANDARD", status: "TRIAL" },
    });
    const s = await provisionStarterState(tx, created.id);
    return { broker: created, starter: s };
  });
  console.log("  " + JSON.stringify(starter));

  check("3 groups created", starter.groupsCreated === 3, `got ${starter.groupsCreated}`);
  check("16 broker symbols created", starter.brokerSymbolsCreated === 16, `got ${starter.brokerSymbolsCreated}`);
  check("desk turned off on a fresh broker", starter.deskTurnedOff === true);

  const fresh = await prisma.broker.findUniqueOrThrow({ where: { id: broker.id } });
  check("dealingDeskAutoFillAt set (desk OFF, orders auto-fill)", fresh.dealingDeskAutoFillAt !== null);

  console.log("\n=== 2. the groups ===");
  const groups = await prisma.group.findMany({ where: { brokerId: broker.id }, orderBy: { name: "asc" } });
  for (const g of groups) {
    console.log(`  ${g.name.padEnd(10)} category=${g.category.padEnd(8)} mode=${String(g.modeRestriction).padEnd(10)} dealing=${String(g.dealingMode).padEnd(8)} default=${g.isDefault} selectable=${g.isClientSelectable} legacyGroupType=${g.groupType}`);
  }
  for (const want of STARTER_GROUPS) {
    const g = groups.find((x) => x.name === want.name);
    check(`group ${want.name} exists with category ${want.category}`, g?.category === want.category);
    check(`group ${want.name} is client-selectable`, g?.isClientSelectable === true);
  }
  check("exactly one default group", groups.filter((g) => g.isDefault).length === 1);
  check("the default is Standard", groups.find((g) => g.isDefault)?.name === "Standard");
  check("Demo group is DEMO_ONLY", groups.find((g) => g.name === "Demo")?.modeRestriction === "DEMO_ONLY");
  check("no COVERAGE/REVERSAL/A_BOOK group is selectable",
    !groups.some((g) => g.isClientSelectable && ["COVERAGE", "REVERSAL", "A_BOOK"].includes(g.category)));

  console.log("\n=== 3. the symbols ===");
  const bs = await prisma.brokerSymbol.findMany({
    where: { brokerId: broker.id },
    select: { enabled: true, spreadMarkup: true, minLot: true, maxLot: true, symbol: { select: { name: true, digits: true, contractSize: true } } },
  });
  const names = bs.map((r) => r.symbol.name).sort();
  console.log("  " + names.join(" "));
  check("16 broker symbols", bs.length === 16, `got ${bs.length}`);
  check("all enabled", bs.every((r) => r.enabled));
  check("all at source spread (markup 0)", bs.every((r) => Number(r.spreadMarkup) === 0));
  check("set matches STARTER_SYMBOLS", JSON.stringify(names) === JSON.stringify([...STARTER_SYMBOLS].map((s) => s.name).sort()));
  const dead = ["USDJPY", "USDCAD", "USDCHF", "GER40", "JPN225", "UK100", "XAUEUR", "AUDJPY"];
  check("no dead List-B symbol shipped", !names.some((n) => dead.includes(n)), names.filter((n) => dead.includes(n)).join(","));
  const gold = bs.find((r) => r.symbol.name === "XAUUSD");
  check("XAUUSD digits=2 contractSize=100", gold?.symbol.digits === 2 && gold?.symbol.contractSize.toString() === "100",
    `digits=${gold?.symbol.digits} contract=${gold?.symbol.contractSize}`);

  console.log("\n=== 4. the actual point: can a fresh broker create an account? ===");
  const defaultGroup = await prisma.group.findFirst({ where: { brokerId: broker.id, isDefault: true } });
  try {
    const acct = await provisionAccount({
      brokerId: broker.id,
      fullName: "Gate Tester",
      email: `gate${Date.now()}@example.test`,
      passwordHash: "x".repeat(60),
      accountMode: "DEMO",
      accountTypeId: null,
      currency: "USD",
      leverage: 100,
      groupId: defaultGroup?.id ?? null,
      initialBalance: new (await import("@prisma/client")).Prisma.Decimal(10000),
      country: null, phone: null, dateOfBirth: null, clientId: null, createdByAdminId: null,
    });
    check("provisionAccount succeeded (no NO_GROUP_AVAILABLE)", true, "account " + acct.accountNumber);
  } catch (err) {
    check("provisionAccount succeeded (no NO_GROUP_AVAILABLE)", false, err instanceof Error ? err.message : String(err));
  }

  console.log("\n=== 5. idempotency: run it a second time ===");
  const again = await provisionStarterState(prisma, broker.id);
  console.log("  " + JSON.stringify(again));
  check("second run creates nothing", again.groupsCreated === 0 && again.brokerSymbolsCreated === 0 && again.symbolsCreated === 0);
  check("second run does NOT touch the desk switch", again.deskTurnedOff === false);
  check("still exactly 3 groups", (await prisma.group.count({ where: { brokerId: broker.id } })) === 3);
  check("still exactly 16 symbols", (await prisma.brokerSymbol.count({ where: { brokerId: broker.id } })) === 16);

  console.log("\n=== 6. a broker that turned its desk ON keeps it on ===");
  await prisma.broker.update({ where: { id: broker.id }, data: { dealingDeskAutoFillAt: null } });
  await provisionStarterState(prisma, broker.id);
  const after = await prisma.broker.findUniqueOrThrow({ where: { id: broker.id } });
  check("desk left ON (null) by a re-run", after.dealingDeskAutoFillAt === null);

  // cleanup -- provisionAccount writes an opening-balance Transaction, and
  // Transaction.accountId is RESTRICT, so those go before the accounts.
  await prisma.transaction.deleteMany({ where: { account: { brokerId: broker.id } } });
  await prisma.watchlistItem.deleteMany({ where: { account: { brokerId: broker.id } } });
  await prisma.account.deleteMany({ where: { brokerId: broker.id } });
  await prisma.brokerSymbol.deleteMany({ where: { brokerId: broker.id } });
  await prisma.group.deleteMany({ where: { brokerId: broker.id } });
  await prisma.auditLog.deleteMany({ where: { brokerId: broker.id } });
  await prisma.broker.delete({ where: { id: broker.id } });

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
