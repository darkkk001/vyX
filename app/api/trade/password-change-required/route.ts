import { NextResponse } from "next/server";

// Web security batch 1 S1 (owner 2026-10-29): where lib/account-auth.ts getAccountSession sends a trader session whose account had a staff
// password reset, for every trade API path but change-password, sign-out and the session info. Every method answers the same 403, so a
// followed 307 lands here too. No trading, no withdrawals until the trader chooses a new password.
function refuse() {
  return NextResponse.json({ error: "Choose a new password to continue.", code: "PASSWORD_CHANGE_REQUIRED" }, { status: 403 });
}

export const GET = refuse;
export const POST = refuse;
export const PATCH = refuse;
export const PUT = refuse;
export const DELETE = refuse;
