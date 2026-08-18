import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import CreateBrokerForm from "./CreateBrokerForm";
import EngineSwitch from "./EngineSwitch";

export default async function BrokersPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const brokers = await prisma.broker.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader title="Brokers" />
      <div className="flex flex-col gap-6">
        <Card>
          <Table>
            <TableHead>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Subdomain</TableHeaderCell>
              <TableHeaderCell>Tier</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Engine</TableHeaderCell>
            </TableHead>
            <TableBody>
              {brokers.length === 0 ? (
                <TableEmptyState colSpan={5}>No brokers yet.</TableEmptyState>
              ) : (
                brokers.map((broker) => (
                  <TableRow key={broker.id}>
                    <TableCell>{broker.name}</TableCell>
                    <TableCell mono>{broker.subdomain}</TableCell>
                    <TableCell>
                      <Badge tone="info">{broker.tier}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={broker.status === "ACTIVE" ? "success" : "neutral"}>{broker.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <EngineSwitch brokerId={broker.id} initialEngine={broker.executionEngine} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
        <CreateBrokerForm />
      </div>
    </main>
  );
}
