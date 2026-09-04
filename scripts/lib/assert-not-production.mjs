// Shared guard for every QA/seed/test script that writes to whatever
// DATABASE_URL happens to be active. Incident 2026-09-04: two
// "Accounts Test <suffix>" brokers (acctest-e027058e59,
// acctest-532c2d49f2) turned up in PRODUCTION -- created by
// app/api/manage/accounts/route.test.ts's own fixture helper, almost
// certainly from a local/CI run that had a production DATABASE_URL
// loaded (via dotenv/config) instead of a dev one. A whitelist of "the
// one test broker id this script is allowed to touch" would not have
// caught that: every script here already only ever writes rows it
// derives from a broker it just looked up or created itself, so there
// was never a real risk of hitting some *other* broker in a shared DB.
// The actual failure mode was running at all against a DATABASE_URL
// that resolved to production.
//
// Follow-up the same day: a dedicated Neon dev branch, created FROM
// production so local dev has a realistic dataset, carries a full copy
// of production's data at branch time -- including the real
// "futurixglobal" broker row. Content alone can no longer tell "this is
// actually production" apart from "this is a deliberate dev branch that
// happens to still contain a clone of that row" -- they're byte-
// identical. Content-sniffing was ALSO never a robust signal for the
// original incident either, just the best available without a positive
// alternative -- ALLOW_TEST_DB_WRITES is that alternative: an explicit,
// developer-set opt-in that only ever belongs in a local/dev-branch
// `.env` file, never in Vercel's production env vars (production secrets
// live only in Vercel now -- see CLAUDE.md's Deployment safety section).
// Sets it once, consciously, when pointing .env at a real non-prod
// database; the accidental case this guard exists for in the first place
// (nobody realizes .env still points at prod, so nobody thinks to set or
// unset anything) stays caught by the content check below, unchanged.
export async function assertNotProductionDatabase(prisma) {
  if (process.env.ALLOW_TEST_DB_WRITES === "true") {
    return;
  }
  const prod = await prisma.broker.findFirst({
    where: { subdomain: "futurixglobal" },
    select: { id: true },
  });
  if (prod) {
    throw new Error(
      "Refusing to run: this DATABASE_URL resolves to a database containing " +
        "the real production broker (subdomain 'futurixglobal'). This script " +
        "only ever creates/reads/deletes QA or seed data and must never run " +
        "against production. Check DATABASE_URL/DIRECT_URL before retrying -- " +
        "if this is actually a deliberate dev/test database (e.g. a Neon " +
        "branch cloned from production), set ALLOW_TEST_DB_WRITES=true in " +
        "that environment's own .env, never in Vercel's production env vars."
    );
  }
}
