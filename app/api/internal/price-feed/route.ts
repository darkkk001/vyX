import { NextRequest, NextResponse } from "next/server";
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
// POST with a JSON body and the secret in the Authorization header is the
// transport. The old GET form (?secret=...&data=...) is closed (security
// re-audit 2026-10-23): a secret in a query string lands in request logs. It
// answers 400 without reading the secret or the ticks. The current EA uses
// neither -- see the [payload] route.

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const body = await request.json().catch(() => null);
  return ingestTicks(secret, body);
}

export async function GET() {
  return NextResponse.json(
    { error: "The query-string form is closed. POST the ticks as JSON with Authorization: Bearer <secret>.", code: "QUERY_SECRET_REFUSED" },
    { status: 400 }
  );
}
