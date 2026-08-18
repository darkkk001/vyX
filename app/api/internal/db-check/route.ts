import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
  return NextResponse.json({ database: db.current_database, expectedColumnsFound: columns, brokerCount });
}
