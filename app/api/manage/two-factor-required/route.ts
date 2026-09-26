import { NextResponse } from "next/server";
import { TWO_FACTOR_SETUP_REQUIRED } from "@/lib/auth";

// Phase 2 batch 4: where lib/auth.ts's getAdminSession sends an ENROLMENT-ONLY
// staff session (a backoffice staff member who has not enrolled 2FA yet) that
// called any API path outside STAFF_ENROLLMENT_API_ALLOWLIST. Every method
// answers the same 403 so a followed 307 (which keeps the method and body)
// lands here too. Holds no session logic of its own: the refusal already
// happened in getAdminSession, this only gives it one body every client can
// recognise.
function refuse() {
  return NextResponse.json(
    { error: "two-factor setup required: enrol an authenticator app to continue", code: TWO_FACTOR_SETUP_REQUIRED },
    { status: 403 }
  );
}

export const GET = refuse;
export const POST = refuse;
export const PATCH = refuse;
export const PUT = refuse;
export const DELETE = refuse;
