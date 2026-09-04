import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import SymbolConfigTable from "./SymbolConfigTable";

// No auth check or Prisma query here anymore -- app/manage/(shell)/
// layout.tsx's own MANAGER-or-BROKER_ADMIN guard is identical to what
// this page checked itself. SymbolConfigTable now self-fetches from the
// already-existing /api/manage/symbols GET (extended to include
// brokerSymbolId, which the table needs for the Sessions button).
export const metadata: Metadata = { title: "Symbols - Backoffice" };

export default function ManagerSymbolsPage() {
  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Symbols"
        description="Spread markup, lot limits, swap, and commission per symbol. A symbol with no saved row yet shows the platform default, saving it creates the row."
      />
      <SymbolConfigTable />
    </main>
  );
}
