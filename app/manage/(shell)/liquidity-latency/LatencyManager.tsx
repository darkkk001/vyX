"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

type ProviderRow = { id: string; name: string; status: string };

// No client component existed for this page at all before -- the Server
// Component ran its own Prisma query. Self-fetches from the
// already-existing /api/manage/liquidity-providers GET (LiquidityManager's
// own data source) instead, ignoring the extra contact/protocol fields it
// doesn't need.
export default function LatencyManager() {
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);

  useEffect(() => {
    fetch("/api/manage/liquidity-providers")
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => setProviders([]));
  }, []);

  if (providers === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Liquidity provider</TableHeaderCell>
        <TableHeaderCell align="right">Round-trip latency</TableHeaderCell>
        <TableHeaderCell align="right">Uptime (30d)</TableHeaderCell>
      </TableHead>
      <TableBody>
        {providers.length === 0 ? (
          <TableEmptyState colSpan={3}>No liquidity providers on record yet.</TableEmptyState>
        ) : (
          providers.map((p) => (
            <TableRow key={p.id}>
              <TableCell primary>
                {p.name} <Badge tone="neutral">{p.status}</Badge>
              </TableCell>
              <TableCell align="right" mono>
                <Badge tone="neutral">Not monitored</Badge>
              </TableCell>
              <TableCell align="right" mono>
                <Badge tone="neutral">Not monitored</Badge>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
