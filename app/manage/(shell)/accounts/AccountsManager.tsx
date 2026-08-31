"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { LeverageInput } from "@/components/ui/LeverageInput";
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
  mirror: { direction: "REVERSE" | "SAME"; multiplier: string } | null;
};

export type GroupOption = { id: string; name: string };

const statusTone = { ACTIVE: "success", SUSPENDED: "warning", CLOSED: "neutral" } as const;
const kycTone = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;

// Group reassignment is available to both MANAGER and BROKER_ADMIN
// (matches app/api/manage/accounts/[id]/route.ts's per-field permission
// check); leverage/status/balance-adjustment only render at all when
// `canManageFinance` (BROKER_ADMIN) -- per AdminRole.MANAGER's own schema
// comment, these are finance-adjacent, not dealing-desk config. Adding a
// new account is NOT gated the same way -- any Manager reaching this page
// can onboard a client -- but the modal still hides the starting-balance/
// leverage-override fields for a non-finance Manager, matching
// app/api/manage/accounts/route.ts POST silently forcing both to their
// defaults for that same caller.
export default function AccountsManager({ onOpenAccount }: { onOpenAccount?: (accountId: string) => void } = {}) {
  const [rows, setRows] = useState<AccountRow[] | null>(null);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [canManageFinance, setCanManageFinance] = useState(false);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function reloadRows() {
    return fetch("/api/manage/accounts")
      .then((r) => r.json())
      .then(setRows);
  }

  useEffect(() => {
    reloadRows().catch(() => setRows([]));
    fetch("/api/manage/groups")
      .then((r) => r.json())
      .then((d: { id: string; name: string }[]) => setGroups(d.map((g) => ({ id: g.id, name: g.name }))))
      .catch(() => {});
    fetch("/api/manage/shell-info")
      .then((r) => r.json())
      .then((d: { canManageFinance: boolean }) => setCanManageFinance(d.canManageFinance))
      .catch(() => {});
  }, []);

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
    // The API no longer echoes the password back (never sending a live
    // credential over the network unnecessarily) -- use what was typed
    // into this form instead, which is exactly the same value.
    setCreatedAccount({ accountNumber: created.accountNumber, password: newAccount.password });
    reloadRows().catch(() => {});
  }

  const filtered = (rows ?? []).filter((r) => {
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
    reloadRows().catch(() => {});
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
    reloadRows().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--text-3)]">
        {rows.length} account{rows.length === 1 ? "" : "s"} for this broker.
        {!canManageFinance
          ? " Leverage/status/balance changes -- including a starting balance on a new account -- require Broker Admin or the Account Finance permission."
          : ""}
      </p>
      <div className="flex items-center justify-between gap-3">
        <Input
          type="text"
          placeholder="Search by account number, name, or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Button onClick={openAddModal}>Add account</Button>
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell className="min-w-[220px]">Account</TableHeaderCell>
          <TableHeaderCell className="min-w-[70px]">Type</TableHeaderCell>
          <TableHeaderCell className="min-w-[90px]">Country</TableHeaderCell>
          <TableHeaderCell className="min-w-[90px]">KYC</TableHeaderCell>
          <TableHeaderCell className="min-w-[160px]">Group</TableHeaderCell>
          <TableHeaderCell className="min-w-[130px]">Leverage</TableHeaderCell>
          <TableHeaderCell align="right" className="min-w-[100px]">Balance</TableHeaderCell>
          <TableHeaderCell align="right" className="min-w-[100px]">Credit</TableHeaderCell>
          <TableHeaderCell className="min-w-[150px]">Status</TableHeaderCell>
          <TableHeaderCell align="right" className="min-w-[110px]" title="Reject new orders once today's realized loss reaches this amount">
            Max daily loss
          </TableHeaderCell>
          <TableHeaderCell className="min-w-[140px]" />
        </TableHead>
        <TableBody>
          {filtered.length === 0 ? (
            <TableEmptyState colSpan={11}>No accounts match.</TableEmptyState>
          ) : (
            filtered.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary className="min-w-[220px]">
                  <button
                    type="button"
                    onClick={() => (onOpenAccount ? onOpenAccount(row.id) : (window.location.href = `/manage/accounts/${row.id}`))}
                    className="font-mono hover:underline"
                  >
                    {row.accountNumber}
                  </button>
                  <div className="text-xs font-normal text-[var(--text-3)]">
                    {row.fullName} — {row.email}
                  </div>
                  {row.mirror ? (
                    <Badge tone="accent">
                      Mirrored: {row.mirror.direction === "REVERSE" ? "Reverse" : "Same"} ×{row.mirror.multiplier}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-[70px]">{row.accountType}</TableCell>
                <TableCell className="min-w-[90px]">{row.country ?? "—"}</TableCell>
                <TableCell className="min-w-[90px]">{row.kycStatus ? <Badge tone={kycTone[row.kycStatus]}>{row.kycStatus}</Badge> : <Badge tone="neutral">NO KYC</Badge>}</TableCell>
                <TableCell className="min-w-[160px]">
                  <Select
                    value={row.groupId ?? ""}
                    disabled={busyId === row.id}
                    onChange={(e) => changeGroup(row, e.target.value)}
                    className="w-full"
                  >
                    <option value="">— ungrouped —</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </Select>
                </TableCell>
                <TableCell className="min-w-[130px]">
                  {canManageFinance ? (
                    <LeverageInput
                      defaultValue={row.leverage}
                      disabled={busyId === row.id}
                      onBlur={(e) => e.target.value !== String(row.leverage) && changeLeverage(row, e.target.value)}
                    />
                  ) : (
                    <span className="font-mono">1:{row.leverage}</span>
                  )}
                </TableCell>
                <TableCell align="right" mono className="min-w-[100px]">
                  {row.balance}
                </TableCell>
                <TableCell align="right" mono className="min-w-[100px]">
                  {row.credit}
                </TableCell>
                <TableCell className="min-w-[150px]">
                  {canManageFinance ? (
                    <Select value={row.status} disabled={busyId === row.id} onChange={(e) => changeStatus(row, e.target.value)} className="w-full">
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="SUSPENDED">SUSPENDED</option>
                      <option value="CLOSED">CLOSED</option>
                    </Select>
                  ) : (
                    <Badge tone={statusTone[row.status]}>{row.status}</Badge>
                  )}
                </TableCell>
                <TableCell align="right" mono className="min-w-[110px]">
                  {canManageFinance ? (
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      placeholder="no limit"
                      defaultValue={row.maxDailyLoss ?? ""}
                      disabled={busyId === row.id}
                      onBlur={(e) => e.target.value !== (row.maxDailyLoss ?? "") && changeMaxDailyLoss(row, e.target.value)}
                      className="w-full text-right"
                    />
                  ) : (
                    row.maxDailyLoss ?? "—"
                  )}
                </TableCell>
                <TableCell className="min-w-[140px] whitespace-nowrap">
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
            {canManageFinance && !newAccount.groupId ? (
              <FormField label="Leverage">
                <LeverageInput value={newAccount.leverage} onChange={(e) => setNewAccount((p) => ({ ...p, leverage: e.target.value }))} />
              </FormField>
            ) : null}
            {canManageFinance ? (
              <FormField label="Initial balance (USD)">
                <Input type="text" inputMode="decimal" mono value={newAccount.initialBalance} onChange={(e) => setNewAccount((p) => ({ ...p, initialBalance: e.target.value }))} />
              </FormField>
            ) : null}
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
