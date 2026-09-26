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

  // Phase 2 batch 4 (audit line 163): a throttled request is said to be
  // throttled instead of pretending it was filed. Keyed by the typed e-mail
  // whether or not it exists, so this reveals nothing about which e-mails are
  // real (every e-mail gets the same 3 tries an hour).
  const { allowed } = await checkRateLimit(`admin-forgot-password:${email}`, 3, 3600);
  if (!allowed) {
    return NextResponse.json({ error: "too many reset requests for this e-mail, try again later" }, { status: 429 });
  }

  const admin = await prisma.adminUser.findUnique({ where: { email } });
  // Only records a request for a real, broker-scoped admin (same
  // "don't leak whether this identifier is real" rule as everywhere
  // else) -- always returns the same generic response either way.
  // Phase 2 batch 4: SUPPORT staff included (their requests used to be
  // dropped silently), and the notification names the action that answers it:
  // a broker admin's Team (USR) -> RESET PASSWORD, which shows a one-time
  // temporary password (POST /api/manage/admins/[id]/reset-password).
  if (admin && admin.brokerId && admin.status === "ACTIVE" && (admin.role === "MANAGER" || admin.role === "BROKER_ADMIN" || admin.role === "SUPPORT")) {
    const action = "A broker admin resets it in Team (USR): select the staff member, RESET PASSWORD.";
    await prisma.notification.create({
      data: {
        brokerId: admin.brokerId,
        type: "ADMIN_PASSWORD_RESET_REQUESTED",
        title: `Backoffice password reset requested: ${admin.email}`,
        body: note ? `${admin.email}: ${note} · ${action}` :`${admin.email} requested a backoffice password reset. ${action}`,
        entityType: "AdminUser",
        entityId: admin.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}
