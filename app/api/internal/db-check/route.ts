import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Force dynamic -- this route has no cookies()/headers() call, so
// without this it would be statically evaluated once at build time and
// frozen in the deployment's static output regardless of which env vars
// are active at actual request time.
export const dynamic = "force-dynamic";

// Temporary diagnostic route -- confirms which actual Postgres database
// this deployment is connected to at runtime, since Vercel masks
// Sensitive environment variable values and env var changes only take
// effect on a fresh deployment. Read-only introspection only, no
// secrets/credentials exposed. Remove once the Frankfurt migration is
// confirmed working end to end.
export async function GET() {
  const [db] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  const columns = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE (table_name = 'BrokerSymbol' AND column_name = 'tradingMode')
       OR (table_name = 'IbRelationship' AND column_name = 'lastPayoutAt')
       OR (table_name = 'Account' AND column_name = 'maxDailyLoss')
  `;
  const brokerCount = await prisma.broker.count();

  // Reveals just enough of the actual runtime env var to fingerprint
  // which database it points at (host + first 12 chars of the username
  // token), without exposing the password -- Vercel's dashboard masks
  // Sensitive values entirely, so this is the only way to confirm what
  // process.env actually resolves to versus what the dashboard shows.
  function fingerprint(name: string) {
    const raw = process.env[name];
    if (!raw) return null;
    try {
      const url = new URL(raw);
      return { host: url.host, userPrefix: url.username.slice(0, 12) };
    } catch {
      return "unparseable";
    }
  }

  return NextResponse.json({
    database: db.current_database,
    expectedColumnsFound: columns,
    brokerCount,
    DATABASE_URL: fingerprint("DATABASE_URL"),
    DIRECT_URL: fingerprint("DIRECT_URL"),
    VYX_TEST_MARKER: process.env.VYX_TEST_MARKER ?? null,
  });
}
