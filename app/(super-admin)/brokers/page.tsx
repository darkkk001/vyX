import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import CreateBrokerForm from "./CreateBrokerForm";
import EngineSwitch from "./EngineSwitch";

export default async function BrokersPage() {
  const session = await getAdminSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    redirect("/login");
  }

  const brokers = await prisma.broker.findMany({ orderBy: { createdAt: "desc" } });

  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1>Brokers</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th align="left">Name</th>
            <th align="left">Subdomain</th>
            <th align="left">Tier</th>
            <th align="left">Status</th>
            <th align="left">Engine</th>
          </tr>
        </thead>
        <tbody>
          {brokers.map((broker) => (
            <tr key={broker.id}>
              <td>{broker.name}</td>
              <td>{broker.subdomain}</td>
              <td>{broker.tier}</td>
              <td>{broker.status}</td>
              <td>
                <EngineSwitch brokerId={broker.id} initialEngine={broker.executionEngine} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <CreateBrokerForm />
    </main>
  );
}
