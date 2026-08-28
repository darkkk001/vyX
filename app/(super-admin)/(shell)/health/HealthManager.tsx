"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";

type HealthRow = { service: string; status: "operational" | "degraded" | "unmonitored"; latency: string; uptime: string };

// No client component existed for this page at all before -- the Server
// Component ran a live `SELECT 1` timing probe and rendered directly.
// Self-fetches from a new /api/admin/health GET that runs the exact same
// probe server-side (a raw SQL timing measurement can't run from the
// client) instead.
export default function HealthManager() {
  const [rows, setRows] = useState<HealthRow[] | null>(null);

  useEffect(() => {
    fetch("/api/admin/health")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Service</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
        <TableHeaderCell align="right">Latency</TableHeaderCell>
        <TableHeaderCell align="right">Uptime (30d)</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.service}>
            <TableCell primary>{r.service}</TableCell>
            <TableCell>
              <Badge tone={r.status === "operational" ? "success" : r.status === "degraded" ? "danger" : "neutral"}>
                {r.status === "unmonitored" ? "Not monitored" : r.status}
              </Badge>
            </TableCell>
            <TableCell align="right" mono>
              {r.latency}
            </TableCell>
            <TableCell align="right" mono>
              {r.uptime}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
