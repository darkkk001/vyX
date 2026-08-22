import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import ManagerLoginForm from "./ManagerLoginForm";

// Resolved fresh per request (never baked into the build) so a broker's
// branding update takes effect immediately -- same principle as
// app/(broker)/layout.tsx. No session exists yet at this point (that's
// the whole point of a login page), so this reads x-broker-id directly
// rather than going through getManagerSession.
export default async function ManagerLoginPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const broker = brokerId
    ? await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } })
    : null;
  // "Forgot password?" here reaches the platform (Super Admin), not the
  // broker's own support inbox -- this login is the broker's OWN staff
  // logging in, so mailing the broker's own supportEmail (as before)
  // just sent a manager's password-reset request to themselves. Only
  // Super Admin can actually reset a Manager/Broker Admin's password
  // (app/(super-admin)/(shell)/admins), so that's who this should reach.
  const superAdmin = await prisma.adminUser.findFirst({ where: { role: "SUPER_ADMIN" }, select: { email: true } });

  return (
    <ManagerLoginForm
      brokerName={broker?.name ?? "Backoffice"}
      logoUrl={broker?.logoUrl ?? null}
      superAdminEmail={superAdmin?.email ?? null}
    />
  );
}
