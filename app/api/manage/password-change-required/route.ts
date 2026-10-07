import { NextResponse } from "next/server";
import { PASSWORD_CHANGE_REQUIRED } from "@/lib/auth";

// Step 3b item 3: where lib/auth.ts's getAdminSession sends a staff session whose password is older than the broker's change
// interval when it calls any API path outside PASSWORD_CHANGE_API_ALLOWLIST (the same shape as two-factor-required). Every
// method answers the same 403, so a followed 307 lands here too.
function refuse() {
  return NextResponse.json({ error: "your password has expired: change it to continue", code: PASSWORD_CHANGE_REQUIRED }, { status: 403 });
}

export const GET = refuse;
export const POST = refuse;
export const PATCH = refuse;
export const PUT = refuse;
export const DELETE = refuse;
