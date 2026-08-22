import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

// Pre-auth (no admin session exists yet) -- Manager/Broker Admin backoffice
// login's own "Forgot password?", replacing a mailto: link with an
// in-app request Super Admin sees as a Notification. Scoped to broker
// staff only (never Super Admin itself -- there's no one above Super
// Admin to request from; see app/(super-admin)/(shell)/security for how
// that account protects itself instead).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const { allowed } = await checkRateLimit(`admin-forgot-password:${email}`, 3, 3600);
  if (!allowed) {
    return NextResponse.json({ ok: true });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  // Only records a request for a real, broker-scoped admin (same
  // "don't leak whether this identifier is real" rule as everywhere
  // else) -- always returns the same generic response either way.
  if (admin && admin.brokerId && (admin.role === "MANAGER" || admin.role === "BROKER_ADMIN")) {
    await prisma.notification.create({
      data: {
        brokerId: admin.brokerId,
        type: "ADMIN_PASSWORD_RESET_REQUESTED",
        title: `Backoffice password reset requested — ${admin.email}`,
        body: note ? `${admin.email}: ${note}` : `${admin.email} requested a backoffice password reset.`,
        entityType: "AdminUser",
        entityId: admin.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
