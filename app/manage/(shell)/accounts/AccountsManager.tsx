"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
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
  maxDailyLoss: string | null;
  country: string | null;
  kycStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
};

export type GroupOption = { id: string; name: string };

const statusTone = { ACTIVE: "success", SUSPENDED: "warning", CLOSED: "neutral" } as const;
const kycTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

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
  const rows = initialRows;
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [adjustTarget, setAdjustTarget] = useState<AccountRow | null>(null);
  const [adjustType, setAdjustType] = useState<"credit" | "debit">("credit");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const emptyNewAccount = {
    fullName: "", email: "", password: "", accountType: "DEMO" as "DEMO" | "LIVE",
    currency: "USD", groupId: "", leverage: "100", initialBalance: "0",
    country: "", phone: "", dateOfBirth: "",
  };
  const [addOpen, setAddOpen] = useState(false);
  const [newAccount, setNewAccount] = useState(emptyNewAccount);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [createdAccount, setCreatedAccount] = useState<{ accountNumber: string; password: string } | null>(null);

  function openAddModal() {
    setNewAccount(emptyNewAccount);
    setAddError(null);
    setCreatedAccount(null);
    setAddOpen(true);
  }

  async function submitNewAccount() {
    setAddBusy(true);
    setAddError(null);
    const response = await fetch("/api/manage/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...newAccount,
        groupId: newAccount.groupId || undefined,
        leverage: newAccount.groupId ? undefined : Number(newAccount.leverage),
      }),
    });
    setAddBusy(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setAddError(b.error ?? "failed to create account");
      return;
    }
    const created = await response.json();
    setCreatedAccount({ accountNumber: created.accountNumber, password: created.password });
    router.refresh();
  }

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

  async function changeMaxDailyLoss(row: AccountRow, value: string) {
    await patchAccount(row.id, { maxDailyLoss: value.trim() === "" ? null : value.trim() });
  }

  function openAdjustModal(row: AccountRow) {
    setAdjustTarget(row);
    setAdjustType("credit");
    setAdjustAmount("");
    setAdjustNote("");
    setAdjustError(null);
  }

  async function submitAdjustment() {
    if (!adjustTarget) return;
    const magnitude = Number(adjustAmount);
    if (!Number.isFinite(magnitude) || magnitude <= 0) {
      setAdjustError("Enter a valid amount");
      return;
    }
    if (!adjustNote.trim()) {
      setAdjustError("Reason is required for the audit trail");
      return;
    }
    // The API contract is unchanged -- one signed amount. The
    // Credit/Debit select is purely a UI convenience computing the sign.
    const signedAmount = adjustType === "credit" ? magnitude : -magnitude;

    setBusyId(adjustTarget.id);
    setAdjustError(null);
    const response = await fetch(`/api/manage/accounts/${adjustTarget.id}/adjust-balance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: signedAmount, note: adjustNote }),
    });
    setBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setAdjustError(b.error ?? "adjustment failed");
      return;
    }
    setAdjustTarget(null);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <Input
          type="text"
          placeholder="Search by account number, name, or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        {canManageFinance ? <Button onClick={openAddModal}>Add account</Button> : null}
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell>Account</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Country</TableHeaderCell>
          <TableHeaderCell>KYC</TableHeaderCell>
          <TableHeaderCell>Group</TableHeaderCell>
          <TableHeaderCell align="right">Leverage</TableHeaderCell>
          <TableHeaderCell align="right">Balance</TableHeaderCell>
          <TableHeaderCell align="right">Credit</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="right" title="Reject new orders once today's realized loss reaches this amount">
            Max daily loss
          </TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {filtered.length === 0 ? (
            <TableEmptyState colSpan={11}>No accounts match.</TableEmptyState>
          ) : (
            filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  <span className="font-mono">{row.accountNumber}</span>
                  <div className="text-xs font-normal text-[var(--text-3)]">
                    {row.fullName} — {row.email}
                  </div>
                </TableCell>
                <TableCell>{row.accountType}</TableCell>
                <TableCell>{row.country ?? "—"}</TableCell>
                <TableCell>{row.kycStatus ? <Badge tone={kycTone[row.kycStatus]}>{row.kycStatus}</Badge> : <Badge tone="neutral">NO KYC</Badge>}</TableCell>
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
                <TableCell align="right" mono>
                  {canManageFinance ? (
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="no limit"
                      defaultValue={row.maxDailyLoss ?? ""}
                      disabled={busyId === row.id}
                      onBlur={(e) => e.target.value !== (row.maxDailyLoss ?? "") && changeMaxDailyLoss(row, e.target.value)}
                      className="w-24 text-right"
                    />
                  ) : (
                    row.maxDailyLoss ?? "—"
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {canManageFinance ? (
                    <Button size="sm" onClick={() => openAdjustModal(row)}>
                      Adjust balance
                    </Button>
                  ) : null}
                  {errors[row.id] ? <div className="mt-1 text-xs text-[var(--sell)]">{errors[row.id]}</div> : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={adjustTarget !== null} onClose={() => setAdjustTarget(null)} title={`Adjust balance — ${adjustTarget?.accountNumber ?? ""}`}>
        <div className="flex flex-col gap-3">
          <FormField label="Adjustment type">
            <Select value={adjustType} onChange={(e) => setAdjustType(e.target.value as "credit" | "debit")}>
              <option value="credit">Credit (add funds)</option>
              <option value="debit">Debit (remove funds)</option>
            </Select>
          </FormField>
          <FormField label="Amount (USD)">
            <Input type="text" inputMode="decimal" mono placeholder="0.00" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} />
          </FormField>
          <FormField label="Reason (required, logged in audit trail)">
            <textarea
              rows={2}
              value={adjustNote}
              onChange={(e) => setAdjustNote(e.target.value)}
              placeholder="e.g. Manual correction for failed deposit"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none"
            />
          </FormField>
          {adjustError ? <p className="text-sm text-[var(--sell)]">{adjustError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setAdjustTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busyId === adjustTarget?.id} onClick={submitAdjustment}>
              {busyId === adjustTarget?.id ? "Applying..." : "Apply adjustment"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add account">
        {createdAccount ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              Account created. This password is shown once — copy it now, it can&apos;t be retrieved again afterward.
            </p>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] p-3 font-mono text-sm">
              <div>Account: {createdAccount.accountNumber}</div>
              <div>Password: {createdAccount.password}</div>
            </div>
            <ModalActions>
              <Button variant="primary" onClick={() => setAddOpen(false)}>
                Done
              </Button>
            </ModalActions>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <FormField label="Full name">
              <Input value={newAccount.fullName} onChange={(e) => setNewAccount((p) => ({ ...p, fullName: e.target.value }))} />
            </FormField>
            <FormField label="Email">
              <Input type="email" value={newAccount.email} onChange={(e) => setNewAccount((p) => ({ ...p, email: e.target.value }))} />
            </FormField>
            <FormField label="Password (min 8 characters)">
              <Input type="text" mono value={newAccount.password} onChange={(e) => setNewAccount((p) => ({ ...p, password: e.target.value }))} />
            </FormField>
            <div className="flex gap-3">
              <div className="flex-1">
                <FormField label="Account type">
                  <Select value={newAccount.accountType} onChange={(e) => setNewAccount((p) => ({ ...p, accountType: e.target.value as "DEMO" | "LIVE" }))}>
                    <option value="DEMO">DEMO</option>
                    <option value="LIVE">LIVE</option>
                  </Select>
                </FormField>
              </div>
              <div className="flex-1">
                <FormField label="Currency">
                  <Input mono value={newAccount.currency} onChange={(e) => setNewAccount((p) => ({ ...p, currency: e.target.value }))} />
                </FormField>
              </div>
            </div>
            <FormField label="Group (optional)">
              <Select value={newAccount.groupId} onChange={(e) => setNewAccount((p) => ({ ...p, groupId: e.target.value }))}>
                <option value="">— ungrouped —</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </FormField>
            {!newAccount.groupId ? (
              <FormField label="Leverage">
                <Input type="text" inputMode="numeric" mono value={newAccount.leverage} onChange={(e) => setNewAccount((p) => ({ ...p, leverage: e.target.value }))} />
              </FormField>
            ) : null}
            <FormField label="Initial balance (USD)">
              <Input type="text" inputMode="decimal" mono value={newAccount.initialBalance} onChange={(e) => setNewAccount((p) => ({ ...p, initialBalance: e.target.value }))} />
            </FormField>
            <div className="flex gap-3">
              <div className="flex-1">
                <FormField label="Country (optional)">
                  <Input value={newAccount.country} onChange={(e) => setNewAccount((p) => ({ ...p, country: e.target.value }))} />
                </FormField>
              </div>
              <div className="flex-1">
                <FormField label="Phone (optional)">
                  <Input value={newAccount.phone} onChange={(e) => setNewAccount((p) => ({ ...p, phone: e.target.value }))} />
                </FormField>
              </div>
            </div>
            <FormField label="Date of birth (optional)">
              <Input type="date" value={newAccount.dateOfBirth} onChange={(e) => setNewAccount((p) => ({ ...p, dateOfBirth: e.target.value }))} />
            </FormField>
            {addError ? <p className="text-sm text-[var(--sell)]">{addError}</p> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={addBusy} onClick={submitNewAccount}>
                {addBusy ? "Creating..." : "Create account"}
              </Button>
            </ModalActions>
          </div>
        )}
      </Modal>
    </div>
  );
}
