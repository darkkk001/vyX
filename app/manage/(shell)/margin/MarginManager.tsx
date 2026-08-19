import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type MarginRow = {
  accountId: string;
  accountNumber: string;
  positionCount: number;
  exposure: string;
  floatingPnl: string;
  marginLevel: number | null;
  marginCallLevel: number;
  stopOutLevel: number;
};

function statusFor(row: MarginRow): { label: string; tone: "danger" | "warning" | "success" | "neutral" } {
  if (row.marginLevel == null) return { label: "NO FEED", tone: "neutral" };
  if (row.marginLevel < row.stopOutLevel) return { label: "STOP-OUT", tone: "danger" };
  if (row.marginLevel < row.marginCallLevel) return { label: "MARGIN CALL", tone: "warning" };
  return { label: "OK", tone: "success" };
}

export default function MarginManager({ rows }: { rows: MarginRow[] }) {
  return (
    <Table>
      <TableHead>
        <TableHeaderCell>Account</TableHeaderCell>
        <TableHeaderCell align="right">Open positions</TableHeaderCell>
        <TableHeaderCell align="right">Exposure</TableHeaderCell>
        <TableHeaderCell align="right">Floating P&L</TableHeaderCell>
        <TableHeaderCell align="right">Margin level</TableHeaderCell>
        <TableHeaderCell>Status</TableHeaderCell>
      </TableHead>
      <TableBody>
        {rows.length === 0 ? (
          <TableEmptyState colSpan={6}>No accounts with open positions.</TableEmptyState>
        ) : (
          rows.map((row) => {
            const status = statusFor(row);
            return (
              <TableRow key={row.accountId}>
                <TableCell primary mono>{row.accountNumber}</TableCell>
                <TableCell align="right" mono>{row.positionCount}</TableCell>
                <TableCell align="right" mono>{row.exposure}</TableCell>
                <TableCell align="right" mono className={Number(row.floatingPnl) < 0 ? "text-[var(--sell)]" : "text-[var(--buy)]"}>
                  {row.floatingPnl}
                </TableCell>
                <TableCell align="right" mono>{row.marginLevel != null ? `${row.marginLevel.toFixed(0)}%` : "—"}</TableCell>
                <TableCell>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
