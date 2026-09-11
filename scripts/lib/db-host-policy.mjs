// Positive, host-based rule for "may a test or QA script write to this database?".
//
// Incident history: 2026-09-04 test fixtures created brokers in PRODUCTION from a local run whose
// .env still pointed at the production DATABASE_URL. Content-sniffing
// (scripts/lib/assert-not-production.mjs) is per-test opt-in and 16 of 18 DB-touching tests never
// called it. This module is the hard rule, enforced for EVERY vitest run through
// vitest.setup.db-guard.ts and by assertNotProductionDatabase().
//
// Rules, in order:
//   1. Hosts listed in PRODUCTION_DB_HOST_MARKERS (below) or PRODUCTION_DB_HOSTS (env) are blocked
//      outright -- no env var can unblock them. Production's Neon endpoint id lives only in
//      Vercel's (sensitive) DATABASE_URL; paste it into the constant below once read from the Neon
//      console so the block is unconditional and committed.
//   2. localhost / 127.0.0.1 / *.local are always allowed.
//   3. Any other host must be listed in TEST_DB_ALLOWED_HOSTS (comma-separated host names or
//      substrings, e.g. the Neon DEV-branch endpoint id). Set it in the local .env next to the dev
//      DATABASE_URL, never in Vercel. Unknown host => refused. (The dev branch as of 2026-09-11 is
//      ep-old-night-b1tiwh7m: cloned from production ~2026-09-07, no production traffic since.)

export const PRODUCTION_DB_HOST_MARKERS = [
  // e.g. "ep-xxxx-yyyy" -- production Neon endpoint id (read it from the Neon console / Vercel env)
];

function productionMarkers() {
  const env = (process.env.PRODUCTION_DB_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...PRODUCTION_DB_HOST_MARKERS.map((m) => m.toLowerCase()), ...env];
}

export function dbHostOf(url) {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export function isProductionDbUrl(url) {
  const host = dbHostOf(url);
  return productionMarkers().some((m) => host.includes(m));
}

export function testDbVerdict(url, allowlistEnv = process.env.TEST_DB_ALLOWED_HOSTS) {
  const host = dbHostOf(url);
  if (!host) return { ok: true, host, reason: "no database url" };
  if (isProductionDbUrl(url)) return { ok: false, host, reason: "PRODUCTION database host : tests and QA scripts must never run here" };
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) return { ok: true, host, reason: "local database" };
  const allow = (allowlistEnv ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.some((a) => host === a || host.includes(a))) return { ok: true, host, reason: "host on TEST_DB_ALLOWED_HOSTS" };
  return { ok: false, host, reason: "host is not on TEST_DB_ALLOWED_HOSTS (add the Neon DEV-branch endpoint id to .env, never a production one)" };
}
