// Stage 4 load harness -- the WEB reference run (docs/RUST-CUTOVER-PLAN.md §4.2): today's production path,
// lib/risk-monitor.ts evaluateAccountRisk, with its side effects inline, over every account holding an open position
// in id order, pass after pass until a pass closes nothing (the cron / tick path keep calling it the same way).
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_load_web DIRECT_URL=<same> \
//   npx tsx --conditions=react-server scripts/load/run-web.ts <report.json>
import "./env";
import fs from "node:fs";
import { assertLoadDb } from "./env";

const MAX_PASSES = 5;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
  await assertLoadDb(prisma);

  // keep the shocked prices fresh (tickAt < 15 s) for the whole run; the deliberately stale symbol stays stale
  const restamp = () => prisma.$executeRaw`UPDATE "LivePrice" SET "tickAt" = now() WHERE "tickAt" > now() - interval '60 seconds'`;
  await restamp();
  const timer = setInterval(() => void restamp().catch(() => {}), 2000);

  const passes: { accounts: number; closed: number; ms: number; perAccountMs: number[] }[] = [];
  try {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const t0 = performance.now();
      const ids = (await prisma.position.findMany({ where: { status: "OPEN" }, select: { accountId: true }, distinct: ["accountId"] })).map((r) => r.accountId).sort();
      let closed = 0;
      const perAccountMs: number[] = [];
      for (const id of ids) {
        const a0 = performance.now();
        const r = await evaluateAccountRisk(id);
        perAccountMs.push(performance.now() - a0);
        closed += r.slTpClosed.length + r.stopOutClosed.length;
      }
      passes.push({ accounts: ids.length, closed, ms: performance.now() - t0, perAccountMs });
      console.log(`[load:web] pass ${pass + 1}: ${ids.length} accounts, ${closed} closed, ${(performance.now() - t0).toFixed(0)} ms`);
      if (closed === 0) break;
    }
  } finally {
    clearInterval(timer);
  }
  const all = passes.flatMap((p) => p.perAccountMs).sort((a, b) => a - b);
  const q = (f: number) => (all.length ? all[Math.min(all.length - 1, Math.floor(f * all.length))] : 0);
  const report = { passes: passes.map(({ perAccountMs, ...p }) => p), evaluateMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99) } };
  fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 1) + "\n");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
