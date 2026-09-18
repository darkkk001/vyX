import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getClientSession } from "@/lib/client-auth";

// Confirms the whole Stage 1 auth loop actually holds together end to
// end (register -> verify -> login -> session persists), same role
// app/api/trade/me plays for the trader session. Stage 2's portal
// dashboard is the real consumer; this exists now so the auth core is
// independently testable before any UI does.
export async function GET() {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const client = await prisma.client.findUnique({
    where: { id: session.clientId },
    select: { id: true, email: true, fullName: true, phone: true, country: true, dateOfBirth: true, emailVerifiedAt: true, status: true, createdAt: true },
  });
  if (!client) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  return NextResponse.json(client);
}

// Profile tab (Stage 8) -- email is deliberately not editable here: it's
// the login identity and is tied to emailVerifiedAt, so changing it is a
// distinct, bigger feature (re-verification of the new address) this
// route doesn't attempt. Everything else a client can self-serve without
// needing a KYC-grade review.
export async function PATCH(request: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const data: { fullName?: string; phone?: string | null; country?: string | null; dateOfBirth?: Date | null } = {};

  if ("fullName" in (body ?? {})) {
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (!fullName) {
      return NextResponse.json({ error: "full name is required" }, { status: 400 });
    }
    data.fullName = fullName;
  }
  if ("phone" in (body ?? {})) {
    data.phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  }
  if ("country" in (body ?? {})) {
    data.country = typeof body.country === "string" && body.country.trim() ? body.country.trim() : null;
  }
  if ("dateOfBirth" in (body ?? {})) {
    if (typeof body.dateOfBirth === "string" && body.dateOfBirth.trim()) {
      const parsed = new Date(body.dateOfBirth);
      // Same guard as the admin account-creation route's own dateOfBirth
      // check -- a native <input type="date"> can hand back a future
      // date or a nonsense year from free-typing into the year segment.
      if (isNaN(parsed.getTime()) || parsed > new Date() || parsed.getUTCFullYear() < 1900) {
        return NextResponse.json({ error: "date of birth must be a valid date in the past" }, { status: 400 });
      }
      data.dateOfBirth = parsed;
    } else {
      data.dateOfBirth = null;
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const updated = await prisma.client.update({
    where: { id: session.clientId },
    data,
    select: { id: true, email: true, fullName: true, phone: true, country: true, dateOfBirth: true, emailVerifiedAt: true, status: true, createdAt: true },
  });

  return NextResponse.json(updated);
}
