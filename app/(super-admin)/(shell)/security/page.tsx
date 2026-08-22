import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import SecurityManager from "./SecurityManager";

export default async function SuperAdminSecurityPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["SUPER_ADMIN"])) {
    redirect("/login");
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id: session!.adminId },
    select: { twoFactorEnabled: true },
  });

  return (
    <main className="mx-auto max-w-[720px]">
      <PageHeader
        title="Security"
        description="This login is the only way in to platform-wide control -- every broker's tenants, billing, and admin accounts. Two-factor authentication is strongly recommended."
      />
      <SecurityManager initialTwoFactorEnabled={admin?.twoFactorEnabled ?? false} />
    </main>
  );
}
