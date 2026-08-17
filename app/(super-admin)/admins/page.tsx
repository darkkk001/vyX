import { redirect } from "next/navigation";
import Link from "next/link";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <p><Link href="/brokers">&larr; Brokers</Link></p>
      <h1>Admins</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th align="left">Email</th>
            <th align="left">Broker</th>
            <th align="left">Role</th>
            <th align="left">Status</th>
          </tr>
        </thead>
        <tbody>
          {admins.map((admin) => (
            <tr key={admin.id}>
              <td>{admin.email}</td>
              <td>{admin.broker?.name ?? "—"}</td>
              <td>{admin.role}</td>
              <td>{admin.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <CreateAdminForm brokers={brokers} />
    </main>
  );
}
