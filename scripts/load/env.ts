// Stage 4 load harness -- shared safety preamble. Import FIRST (before any lib): refuses any database but the two
// throwaway load databases on the local scratch Postgres, and pins every outbound path local, like
// scripts/parity/run-ts.ts does for the parity harness.
export const LOAD_DBS = {
  web: "postgresql://postgres@127.0.0.1:5499/vyx_load_web",
  engine: "postgresql://postgres@127.0.0.1:5499/vyx_load_engine",
} as const;

const url = process.env.DATABASE_URL;
if (!url || !Object.values(LOAD_DBS).includes(url as never) || process.env.DIRECT_URL !== url) {
  console.error(`[load] refusing to run: DATABASE_URL and DIRECT_URL must both be one of ${Object.values(LOAD_DBS).join(", ")}`);
  process.exit(2);
}
export const LOAD_DB_NAME = url.slice(url.lastIndexOf("/") + 1);

process.env.MARKET_DATA_PRICES = "";
process.env.MARKET_DATA_URL = "";
process.env.TRADING_CORE_URL = "";
process.env.GATEWAY_URL = "http://127.0.0.1:9";
process.env.INTERNAL_SERVICE_SECRET = "";
export const suppressedEvents: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (u.startsWith("http://127.0.0.1:9/internal/events")) {
    suppressedEvents.push(u);
    return new Response(null, { status: 204 });
  }
  throw new Error(`[load] unexpected outbound fetch blocked: ${u}`);
}) as typeof fetch;

/** Re-checks the connected server before the first write. */
export async function assertLoadDb(prisma: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }) {
  const [where] = (await prisma.$queryRaw`SELECT current_database() AS db, inet_server_port() AS port`) as { db: string; port: number }[];
  if (where.db !== LOAD_DB_NAME || Number(where.port) !== 5499) {
    throw new Error(`[load] connected to ${where.db}:${where.port}, expected ${LOAD_DB_NAME}:5499 -- aborting before any write`);
  }
}
