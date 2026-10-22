// QoreBridge M5 live end-to-end test: the fixtures on the QA tenant "zzzqa" (owner, 2026-10-23: "zzzqa; Futurix /
// Seawolf ko mat chhedo"). It never touches another tenant:
//   - the broker is resolved ONLY by the hard-coded subdomain below; every read and write is scoped to its id;
//   - it creates, idempotently by natural key: the A_BOOK test group (a copy of zzzqa's "Standard-USD" settings, not
//     client-selectable), one LIVE test account in it (QA money only), the simulated LP entry and one routing rule
//     (test group, every symbol, that LP, priority 1, weight 1). One audit row per create (action M5_TEST_SETUP);
//   - the account number is 4998xxxx: BELOW the live maximum, so allocateAccountNumber (MAX + 1, platform-wide) never
//     hands out a number after it and real tenants' numbering is unaffected (the zzshadowbot seed's rule);
//   - --disable turns the routing rule off (nothing is hedged for the group any more); rows are never deleted, the
//     test's trades stay in the ledger like any other QA trade.
//
// Usage (DATABASE_URL and DIRECT_URL must be set in the process env -- .env is never read):
//   npx tsx scripts/qorebridge/m5-live-setup.ts                        dry run: prints the plan, writes nothing
//   npx tsx scripts/qorebridge/m5-live-setup.ts --apply --confirm-host=<db host>
//   npx tsx scripts/qorebridge/m5-live-setup.ts --disable --apply --confirm-host=<db host>
// M5_TEST_PASSWORD (env, 8+ characters) is the test account's trader password; needed when the account is created.
// Prints the ids the VPS runbook needs (broker id, LP id), never a password.
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { INITIAL_BALANCE_NOTE } from "../../lib/initial-balance";

export const SUBDOMAIN = "zzzqa";
export const TEMPLATE_GROUP = "Standard-USD";
export const TEST_GROUP = "QB M5 Test A-Book";
export const TEST_ACCOUNT = "49980001";
export const TEST_EMAIL = "qb-m5-test@zzzqa.local";
export const LP_NAME = "QoreBridge Sim LP";
export const START_BALANCE = new Prisma.Decimal(10000);
const ACTION = "M5_TEST_SETUP";

export class SetupRefused extends Error {}
type Tx = Prisma.TransactionClient;

export async function setupM5Test(db: Tx, opts: { apply: boolean; disable: boolean; passwordHash: string | null }) {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  let changes = 0;
  const change = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    changes++;
    log(`${opts.apply ? "DONE  " : "PLAN  "} ${what}`);
    return opts.apply ? run() : null;
  };

  const broker = await db.broker.findUnique({ where: { subdomain: SUBDOMAIN }, select: { id: true } });
  if (!broker) throw new SetupRefused(`broker ${SUBDOMAIN} not found`);
  const brokerId = broker.id;
  const audit = (entityType: string, entityId: string, newValue: Prisma.InputJsonValue) =>
    db.auditLog.create({ data: { brokerId, actorAdminId: null, action: ACTION, entityType, entityId, newValue } });

  // the account number must be free platform-wide, or ours already
  const numberOwner = await db.account.findUnique({ where: { accountNumber: TEST_ACCOUNT }, select: { brokerId: true } });
  if (numberOwner && numberOwner.brokerId !== brokerId) throw new SetupRefused(`account number ${TEST_ACCOUNT} belongs to another broker`);

  // ---- the A_BOOK test group: zzzqa's Standard-USD settings, category A_BOOK, not client-selectable ----
  let group = await db.group.findFirst({ where: { brokerId, name: TEST_GROUP } });
  if (group && group.category !== "A_BOOK") throw new SetupRefused(`group ${TEST_GROUP} exists with category ${group.category}`);
  if (!group) {
    const template = await db.group.findFirst({ where: { brokerId, name: TEMPLATE_GROUP } });
    if (!template) throw new SetupRefused(`template group ${TEMPLATE_GROUP} not found`);
    const { id: _id, name: _name, brokerId: _b, createdAt: _c, updatedAt: _u, ...settings } = template as typeof template & { updatedAt?: Date };
    const data = { ...settings, brokerId, name: TEST_GROUP, category: "A_BOOK" as const, isClientSelectable: false } as Prisma.GroupUncheckedCreateInput;
    group = await change(`create group ${TEST_GROUP} (A_BOOK, copy of ${TEMPLATE_GROUP}, not client-selectable)`, async () => {
      const g = await db.group.create({ data });
      await audit("Group", g.id, { name: TEST_GROUP, category: "A_BOOK", template: TEMPLATE_GROUP });
      return g;
    });
  } else log(`ok     group ${TEST_GROUP} (${group.id})`);

  // ---- the LIVE test account (QA money), funded the way provisioning funds an account ----
  const account = await db.account.findUnique({ where: { accountNumber: TEST_ACCOUNT }, select: { id: true, groupId: true, accountMode: true } });
  if (account) {
    if (group && account.groupId !== group.id) throw new SetupRefused(`account ${TEST_ACCOUNT} is not in ${TEST_GROUP}`);
    log(`ok     account ${TEST_ACCOUNT} (${account.accountMode})`);
  } else {
    if (opts.apply && !opts.passwordHash) throw new SetupRefused("M5_TEST_PASSWORD is needed to create the test account");
    await change(`create account ${TEST_ACCOUNT} (LIVE, USD, 1:100, in ${TEST_GROUP}, balance ${START_BALANCE.toFixed(2)})`, async () => {
      const a = await db.account.create({
        data: {
          brokerId, groupId: group!.id, accountNumber: TEST_ACCOUNT, email: TEST_EMAIL, passwordHash: opts.passwordHash!, fullName: "QB M5 Test",
          accountMode: "LIVE", currency: "USD", leverage: 100, balance: START_BALANCE,
        },
      });
      await db.transaction.create({
        data: { brokerId, accountId: a.id, type: "ADJUSTMENT", status: "COMPLETED", amount: START_BALANCE, balanceBefore: new Prisma.Decimal(0), balanceAfter: START_BALANCE, note: INITIAL_BALANCE_NOTE },
      });
      await audit("Account", a.id, { accountNumber: TEST_ACCOUNT, accountMode: "LIVE", group: TEST_GROUP, initialBalance: START_BALANCE.toFixed(2) });
      return a;
    });
  }

  // ---- the simulated LP entry ----
  let lp = await db.liquidityProvider.findFirst({ where: { brokerId, name: LP_NAME } });
  if (!lp) {
    lp = await change(`create LP ${LP_NAME} (FIX 4.4, CONNECTED)`, async () => {
      const row = await db.liquidityProvider.create({
        data: { brokerId, name: LP_NAME, protocol: "FIX 4.4", status: "CONNECTED", notes: "Simulated LP for the QoreBridge M5 test (QA tenant, no real money)" },
      });
      await audit("LiquidityProvider", row.id, { name: LP_NAME, status: "CONNECTED" });
      return row;
    });
  } else log(`ok     LP ${LP_NAME} (${lp.id})`);

  // ---- the routing rule: test group, every symbol, that LP ----
  const rule = group && lp ? await db.lpRoutingRule.findFirst({ where: { brokerId, groupId: group.id, symbolId: null, liquidityProviderId: lp.id } }) : null;
  const wantEnabled = !opts.disable;
  if (!rule) {
    if (opts.disable) log("ok     no routing rule to disable");
    else
      await change(`create routing rule ${TEST_GROUP} / every symbol -> ${LP_NAME} (priority 1, weight 1)`, async () => {
        const r = await db.lpRoutingRule.create({
          data: { brokerId, groupId: group!.id, symbolId: null, liquidityProviderId: lp!.id, priority: 1, weight: new Prisma.Decimal(1), enabled: true, notes: "QoreBridge M5 test" },
        });
        await audit("LpRoutingRule", r.id, { group: TEST_GROUP, lp: LP_NAME, priority: 1, weight: "1", enabled: true });
        return r;
      });
  } else if (rule.enabled !== wantEnabled) {
    await change(`${wantEnabled ? "enable" : "disable"} routing rule ${rule.id}`, async () => {
      await db.lpRoutingRule.update({ where: { id: rule.id }, data: { enabled: wantEnabled } });
      await audit("LpRoutingRule", rule.id, { enabled: wantEnabled });
    });
  } else log(`ok     routing rule ${rule.id} (enabled ${rule.enabled})`);

  log(`${changes} change(s)${opts.apply ? " applied" : " planned (dry run: nothing written)"}`);
  log(`broker id: ${brokerId}`);
  log(`LP id: ${lp?.id ?? "(created on --apply)"}`);
  return { lines, changes, brokerId, lpId: lp?.id ?? null, groupId: group?.id ?? null };
}

// ---- CLI ----

export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

async function main() {
  const args = process.argv.slice(2);
  const known = ["--apply", "--disable"];
  const apply = args.includes("--apply");
  const disable = args.includes("--disable");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => !known.includes(a) && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new SetupRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new SetupRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new SetupRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new SetupRefused(`--apply on ${host} needs --confirm-host=${host}`);
  const password = process.env.M5_TEST_PASSWORD || null;
  if (password && password.length < 8) throw new SetupRefused("M5_TEST_PASSWORD must be at least 8 characters");
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return setupM5Test(tx, { apply, disable, passwordHash });
      },
      { timeout: 60_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /m5-live-setup\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof SetupRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
