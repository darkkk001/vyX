import { NextRequest } from "next/server";
import { ingestTicks } from "@/lib/price-feed";

// Ingest endpoint for the MT5 EA bridge — pushes live bid/ask ticks from a
// broker's own MT5 terminal so the WebTrader chart can show real prices
// instead of the client-side simulator. Temporary Phase-2.5 stopgap; a real
// LP FIX feed replaces this in Phase 5 without touching anything downstream,
// since consumers only ever read the LivePrice table.
//
// Auth: shared-secret bearer token (there is no per-broker identity here,
// the feed is broker-agnostic raw market data — BrokerSymbol.spreadMarkup
// is applied on top when quoting a trader).
//
// Two transports exist because real-world network paths vary: POST with a
// JSON body is the clean path; GET with query params is a fallback for
// paths that downgrade POST to GET. Neither transport is used by the
// current EA — see the [payload] route for why.

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const body = await request.json().catch(() => null);
  return ingestTicks(secret, body);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  const data = searchParams.get("data");
  let ticksRaw: unknown = null;
  if (data) {
    try {
      ticksRaw = JSON.parse(data);
    } catch {
      ticksRaw = null;
    }
  }
  return ingestTicks(secret, ticksRaw);
}
