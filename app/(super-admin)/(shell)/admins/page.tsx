import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import CreateAdminForm from "./CreateAdminForm";

export default async function AdminsPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const [admins, brokers] = await Promise.all([
    prisma.adminUser.findMany({
      orderBy: { createdAt: "desc" },
      include: { broker: { select: { name: true } } },
    }),
    prisma.broker.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Admins" description="Broker-scoped admin accounts across every tenant" />
      <div className="flex flex-col gap-6">
        <Table>
          <TableHead>
            <TableHeaderCell>Email</TableHeaderCell>
            <TableHeaderCell>Broker</TableHeaderCell>
            <TableHeaderCell>Role</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableHead>
          <TableBody>
            {admins.length === 0 ? (
              <TableEmptyState colSpan={4}>No admins yet.</TableEmptyState>
            ) : (
              admins.map((admin) => (
                <TableRow key={admin.id}>
                  <TableCell primary>{admin.email}</TableCell>
                  <TableCell>{admin.broker?.name ?? "—"}</TableCell>
                  <TableCell>
                    <Badge tone="accent">{admin.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge tone={admin.status === "ACTIVE" ? "success" : "neutral"}>{admin.status}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <CreateAdminForm brokers={brokers} />
      </div>
    </main>
  );
}
