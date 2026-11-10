// LOCAL ONLY (not for any deployed database): screenshots of the Liquidity page's bridge status console with a
// synthetic v2 report in the local Redis, against the scratch DB. Refuses any database that is not 127.0.0.1 / localhost.
//   NODE_OPTIONS=--conditions=react-server DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test REDIS_URL=redis://127.0.0.1:6379 \
//     npx tsx --tsconfig tsconfig.json scripts/local-shot-bridge-console.ts <outDir> [baseUrl=http://bscdemo.localhost:3999]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { randomBytes } from "node:crypto";
// lib/auth.ts createSessionToken, written directly (lib/auth pulls in next/navigation, which does not load outside Next)
const SESSION_COOKIE_NAME = "vyx_admin_session";

const out = process.argv[2] ?? "shots";
const base = process.argv[3] ?? "http://bscdemo.localhost:3999";

async function main() {
  const db = process.env.DATABASE_URL ?? "";
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(db)) throw new Error("local scratch database only");
  mkdirSync(out, { recursive: true });

  const broker = await prisma.broker.upsert({ where: { subdomain: "bscdemo" }, update: {}, create: { name: "Futurix Demo (local)", subdomain: "bscdemo" } });
  const admin = await prisma.adminUser.upsert({
    where: { email: "bsc-admin@test.local" },
    update: { brokerId: broker.id, role: "BROKER_ADMIN", status: "ACTIVE", twoFactorEnabled: true },
    create: { email: "bsc-admin@test.local", passwordHash: "x", role: "BROKER_ADMIN", status: "ACTIVE", brokerId: broker.id, twoFactorEnabled: true },
  });
  const lp = async (name: string) =>
    (await prisma.liquidityProvider.findFirst({ where: { brokerId: broker.id, name } })) ?? (await prisma.liquidityProvider.create({ data: { brokerId: broker.id, name, status: "CONNECTED" } }));
  const [a, b] = [await lp("Prime LP One"), await lp("Atlas FIX")];
  const token = randomBytes(32).toString("hex");
  await getRedis().set(`admin_session:${token}`, JSON.stringify({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: broker.id, sessionId: randomBytes(16).toString("hex"), iat: Date.now() }), "EX", 3600);

  const report = (detail: unknown) =>
    getRedis().set(
      `bridge-status:${broker.id}`,
      JSON.stringify({ licenseId: "local-shot", receivedAt: Date.now(), lpsReady: 1, lpsTotal: 2, intake: "ok", feed: "off", licenseExpiresAt: null, detail }),
      "EX",
      120
    );
  const v2 = (license: unknown, held: number) => ({
    v: 2,
    health: "degraded",
    hedging: true,
    license,
    lanes: [
      { id: a.id, state: "ready", inFlight: 2, openPositions: 0, delivered: 418, completedSinceStart: 137, logonRejects: 0, maintenanceRefusals: 3 },
      { id: b.id, state: "maintenance", inFlight: 0, openPositions: 0, delivered: 96, completedSinceStart: 41, logonRejects: 1, maintenanceRefusals: 12 },
      { id: "c03bd15e7a6cdf961b0966bb5", state: "auth_halted", inFlight: 0, openPositions: 0, delivered: 0, completedSinceStart: 0, logonRejects: 3, maintenanceRefusals: 0 },
    ],
    held: { total: held, byReason: { market_closed: 0, lp_reconnecting: held, no_lp_up: 0, db_error: 0, lane_stopped: 0, license_suspended: 0 } },
  });

  const browser = await chromium.launch();
  const shoot = async (name: string, theme: "dark" | "light", width: number) => {
    await prisma.adminUser.update({ where: { id: admin.id }, data: { theme } });   // the backoffice theme is the admin's own (DB)
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const host = new URL(base).hostname;
    await ctx.addCookies([{ name: SESSION_COOKIE_NAME, value: token, domain: host, path: "/" }]);
    const page = await ctx.newPage();
    await page.goto(`${base}/manage/liquidity`, { waitUntil: "networkidle" });
    await page.getByText("Liquidity bridge").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `${name}-page.png`), fullPage: false });
    await ctx.close();
  };

  await report(v2({ state: "active", reason: null, graceUntil: null }, 2));
  await shoot("v2-active-dark-1440", "dark", 1440);
  await report(v2({ state: "grace", reason: null, graceUntil: Date.now() + 36 * 3_600_000 }, 2));
  await shoot("v2-grace-light-1366", "light", 1366);
  await report(null); // an older bridge: v1 keys only
  await shoot("v1-older-bridge-dark-1440", "dark", 1440);
  await browser.close();
  await getRedis().del(`bridge-status:${broker.id}`);
  console.log(`shots in ${out}`);
  await prisma.$disconnect();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
