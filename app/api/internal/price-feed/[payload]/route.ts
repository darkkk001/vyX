import { NextRequest, NextResponse } from "next/server";
import { ingestTicks } from "@/lib/price-feed";

// Path-based transport for the MT5 EA bridge. Production traffic from real
// broker MT5 terminals showed the query string on GET /price-feed?secret=...
// arriving at the server completely empty (secret and data both null) even
// though the same request works fine from other networks — some network
// intermediary between those terminals and Vercel (ISP DPI, router-level ad
// blocker, AV web filter) strips query strings outright. Base64url-encoding
// {secret, ticks} into a path segment survives that, since none of those
// intermediaries rewrite path structure.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ payload: string }> }
) {
  const { payload } = await params;
  let decoded: { secret?: string; ticks?: unknown } = {};
  let jsonAttempt = "";
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    jsonAttempt = Buffer.from(base64, "base64").toString("utf-8");
    decoded = JSON.parse(jsonAttempt);
  } catch (e) {
    // TEMP DEBUG — remove once the EA payload mismatch is diagnosed.
    return NextResponse.json(
      {
        error: "bad payload",
        debugReceivedPayload: payload,
        debugReceivedLength: payload.length,
        debugDecodeAttempt: jsonAttempt,
        debugErrorMessage: e instanceof Error ? e.message : String(e),
      },
      { status: 400 }
    );
  }
  return ingestTicks(decoded.secret ?? null, decoded.ticks ?? null);
}
