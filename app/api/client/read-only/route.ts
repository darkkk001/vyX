import { NextResponse } from "next/server";

// Where a write from a read-only session lands (lib/account-auth.ts getAccountSession), the same way an outdated build
// lands on /api/client/update-required. The method survives the redirect, so every method answers.
const refuse = () => NextResponse.json({ error: "Read-only access. Sign in with the trading password to trade.", code: "READ_ONLY_SESSION" }, { status: 403 });
export const GET = refuse;
export const POST = refuse;
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;
