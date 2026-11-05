import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/client-auth";

// POST: the client is really here (input in an open Trader's Room tab, at most once a minute). This is what holds off the
// idle limit; the background reads of the room do not (lib/client-auth.ts).
export async function POST() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Signed out. Sign in again." }, { status: 401 });
  return new NextResponse(null, { status: 204 });
}
