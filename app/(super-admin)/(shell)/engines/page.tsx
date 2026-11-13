import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import EnginesManager from "./EnginesManager";

// Multi-engine control plane (owner 2026-11-13): the engine registry, each engine's roster and the broker moves. The shell layout's SUPER_ADMIN
// guard covers this page; the data comes from /api/admin/engines.
export const metadata: Metadata = { title: "Engines - Super Admin" };

export default function EnginesPage() {
  return (
    <main className="mx-auto max-w-6xl">
      <PageHeader title="Engines" description="Every deployed engine, its health and the brokers it runs" />
      <EnginesManager />
    </main>
  );
}
