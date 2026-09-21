import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";

// Client-facing list of the groups a client may open an account in.
//
// The group is the tier: it carries the routing AND, through
// GroupSymbolConfig, the spread and commission that actually reach a fill
// (docs/CURRENT-STRUCTURE-MAP.md §3). So a client choosing their "account
// type" is really choosing a group -- but only from the ones meant for them.
//
// EXCLUDED, and why each matters:
//   COVERAGE  the broker's own hedge account lives here (lib/coverage.ts).
//             lib/account-structure.ts already refuses a client account in
//             one; this stops it ever being offered in the first place.
//   REVERSAL  the reverse-copy source book. A client landing in it would be
//             mirrored into the broker's master account.
//   A_BOOK / LIVE_ONLY / DEMO_ONLY  filtered per the requested mode, the same
//             rule lib/account-structure.ts enforces on the write.
//
// Routing itself is never returned. A client must not be able to tell whether
// they are A-booked, B-booked or dealt, which is the whole point of keeping
// routing on the group and off the client-facing label.
const CLIENT_ELIGIBLE = ["B_BOOK", "DEALING"] as const;

export async function GET(request: Request) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const mode = new URL(request.url).searchParams.get("mode") === "LIVE" ? "LIVE" : "DEMO";

  const groups = await prisma.group.findMany({
    where: {
      brokerId: session.brokerId,
      category: { in: [...CLIENT_ELIGIBLE] },
      modeRestriction: mode === "DEMO" ? { in: ["ANY", "DEMO_ONLY"] } : { in: ["ANY", "LIVE_ONLY"] },
      tradingHaltedAt: null,
    },
    select: {
      id: true,
      name: true,
      leverage: true,
      swapFree: true,
      isDefault: true,
      symbolConfigs: {
        select: { spreadMarkup: true, commissionPerLot: true, symbol: { select: { name: true } } },
        orderBy: { symbol: { name: "asc" } },
      },
    },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });

  return NextResponse.json(
    groups.map((g) => ({
      id: g.id,
      name: g.name,
      leverage: g.leverage,
      swapFree: g.swapFree === true,
      isDefault: g.isDefault,
      // What this group costs to trade. An empty list means it carries no
      // per-symbol override, i.e. the broker's standard pricing -- rendered as
      // "standard pricing", never as "0", so a client is not told a spread is
      // zero when it simply is not set here.
      pricing: g.symbolConfigs
        .filter((c) => c.spreadMarkup !== null || c.commissionPerLot !== null)
        .map((c) => ({
          symbol: c.symbol.name,
          spreadMarkup: c.spreadMarkup?.toString() ?? null,
          commissionPerLot: c.commissionPerLot?.toString() ?? null,
        })),
    }))
  );
}
