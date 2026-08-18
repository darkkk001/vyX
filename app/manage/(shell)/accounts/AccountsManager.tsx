"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type AccountRow = {
  id: string;
  accountNumber: string;
  fullName: string;
  email: string;
  accountType: string;
  currency: string;
  leverage: number;
  balance: string;
  credit: string;
  status: "ACTIVE" | "SUSPENDED" | "CLOSED";
  groupId: string | null;
  groupName: string | null;
};

export type GroupOption = { id: string; name: string };

const statusTone = { ACTIVE: "success", SUSPENDED: "warning", CLOSED: "neutral" } as const;

// Group reassignment is available to both MANAGER and BROKER_ADMIN
// (matches app/api/manage/accounts/[id]/route.ts's per-field permission
// check); leverage/status/balance-adjustment only render at all when
// `canManageFinance` (BROKER_ADMIN) -- per AdminRole.MANAGER's own schema
// comment, these are finance-adjacent, not dealing-desk config.
export default function AccountsManager({
  initialRows,
  groups,
  canManageFinance,
}: {
  initialRows: AccountRow[];
  groups: GroupOption[];
  canManageFinance: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<AccountRow[]>(initialRows);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adjustOpenId, setAdjustOpenId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");

  const filtered = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return r.accountNumber.toLowerCase().includes(q) || r.fullName.toLowerCase().includes(q) || r.email.toLowerCase().includes(q);
  });

  async function patchAccount(id: string, body: Record<string, unknown>) {
    setBusyId(id);
    setErrors((prev) => ({ ...prev, [id]: "" }));
    const response = await fetch(`/api/manage/accounts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [id]: b.error ?? "update failed" }));
      return false;
    }
    router.refresh();
    return true;
  }

  async function changeGroup(row: AccountRow, groupId: string) {
    await patchAccount(row.id, { groupId: groupId || null });
  }

  async function changeStatus(row: AccountRow, status: string) {
    await patchAccount(row.id, { status });
  }

  async function changeLeverage(row: AccountRow, leverage: string) {
    const n = Number(leverage);
    if (!Number.isFinite(n) || n <= 0) return;
    await patchAccount(row.id, { leverage: n });
  }

  async function submitAdjustment(row: AccountRow) {
    setBusyId(row.id);
    setErrors((prev) => ({ ...prev, [row.id]: "" }));
    const response = await fetch(`/api/manage/accounts/${row.id}/adjust-balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: adjustAmount, note: adjustNote }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.id]: b.error ?? "adjustment failed" }));
      return;
    }
    setAdjustOpenId(null);
    setAdjustAmount("");
    setAdjustNote("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Input
        type="text"
        placeholder="Search by account number, name, or email..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Group</TableHeaderCell>
          <TableHeaderCell align="right">Leverage</TableHeaderCell>
          <TableHeaderCell align="right">Balance</TableHeaderCell>
          <TableHeaderCell align="right">Credit</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {filtered.length === 0 ? (
            <TableEmptyState colSpan={8}>No accounts match.</TableEmptyState>
          ) : (
            filtered.map((row) => (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell>
                    <span className="font-mono">{row.accountNumber}</span>
                    <div className="text-xs text-slate-400">
                      {row.fullName} — {row.email}
                    </div>
                  </TableCell>
                  <TableCell>{row.accountType}</TableCell>
                  <TableCell>
                    <Select
                      value={row.groupId ?? ""}
                      disabled={busyId === row.id}
                      onChange={(e) => changeGroup(row, e.target.value)}
                      className="w-36"
                    >
                      <option value="">— ungrouped —</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell align="right" mono>
                    {canManageFinance ? (
                      <Input
                        type="text"
                        inputMode="numeric"
                        mono
                        defaultValue={row.leverage}
                        disabled={busyId === row.id}
                        onBlur={(e) => e.target.value !== String(row.leverage) && changeLeverage(row, e.target.value)}
                        className="w-16 text-right"
                      />
                    ) : (
                      row.leverage
                    )}
                  </TableCell>
                  <TableCell align="right" mono>
                    {row.balance}
                  </TableCell>
                  <TableCell align="right" mono>
                    {row.credit}
                  </TableCell>
                  <TableCell>
                    {canManageFinance ? (
                      <Select value={row.status} disabled={busyId === row.id} onChange={(e) => changeStatus(row, e.target.value)} className="w-32">
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                        <option value="CLOSED">CLOSED</option>
                      </Select>
                    ) : (
                      <Badge tone={statusTone[row.status]}>{row.status}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {canManageFinance ? (
                      <Button size="sm" onClick={() => setAdjustOpenId(adjustOpenId === row.id ? null : row.id)}>
                        Adjust balance
                      </Button>
                    ) : null}
                    {errors[row.id] ? <div className="mt-1 text-xs text-rose-600">{errors[row.id]}</div> : null}
                  </TableCell>
                </TableRow>
                {adjustOpenId === row.id ? (
                  <tr>
                    <td colSpan={8} className="bg-slate-50 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="text"
                          inputMode="decimal"
                          mono
                          placeholder="Amount (+/-)"
                          value={adjustAmount}
                          onChange={(e) => setAdjustAmount(e.target.value)}
                          className="w-28"
                        />
                        <Input
                          type="text"
                          placeholder="Reason (required)"
                          value={adjustNote}
                          onChange={(e) => setAdjustNote(e.target.value)}
                          className="w-72"
                        />
                        <Button size="sm" variant="primary" disabled={busyId === row.id} onClick={() => submitAdjustment(row)}>
                          {busyId === row.id ? "Submitting..." : "Submit"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAdjustOpenId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
