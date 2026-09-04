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
// that resolved to production. This checks for the one broker that can
// only ever exist there (a single findFirst -- never lists/enumerates
// brokers) and refuses to proceed if found.
export async function assertNotProductionDatabase(prisma) {
  const prod = await prisma.broker.findFirst({
    where: { subdomain: "futurixglobal" },
    select: { id: true },
  });
  if (prod) {
    throw new Error(
      "Refusing to run: this DATABASE_URL resolves to a database containing " +
        "the real production broker (subdomain 'futurixglobal'). This script " +
        "only ever creates/reads/deletes QA or seed data and must never run " +
        "against production. Check DATABASE_URL/DIRECT_URL before retrying."
    );
  }
}
