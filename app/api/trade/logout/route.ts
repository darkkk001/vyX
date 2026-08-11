import { NextResponse } from "next/server";
import { ACCOUNT_SESSION_COOKIE_NAME } from "@/lib/account-auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ACCOUNT_SESSION_COOKIE_NAME);
  return response;
}
