import { NextResponse } from "next/server";

// Closed (security re-audit 2026-10-23, owner go after the VPS check): this path carried the feed secret base64-encoded
// in the URL, so it landed in request logs. It was the MT5 EA's proxy transport; the live EA (C:\MT5-Pepperstone, profile
// VyXFeed) runs in direct mode (UseDirectMode=true, DirectServerUrl=http://127.0.0.1:8081) and never calls it. Same
// treatment as the GET query form: 400 without decoding or reading anything. The feed goes EA -> VPS engine directly.
export async function GET() {
  return NextResponse.json(
    { error: "The path form is closed. Send ticks to the market data engine directly (EA direct mode).", code: "PATH_SECRET_REFUSED" },
    { status: 400 }
  );
}
