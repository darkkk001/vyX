"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";

export type LeadRow = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  country: string | null;
  source: string | null;
  status: "NEW" | "CONTACTED" | "QUALIFIED" | "CONVERTED" | "LOST";
  convertedAccountNumber: string | null;
  createdAt: string;
};

const statusTone = { NEW: "info", CONTACTED: "accent", QUALIFIED: "warning", CONVERTED: "success", LOST: "neutral" } as const;

// Self-fetches from the already-existing /api/manage/leads GET, plus
// /api/manage/shell-info for the requesting admin's own role (canConvert
// = BROKER_ADMIN) -- instead of receiving both as server-rendered props.
export default function LeadsManager() {
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [canConvert, setCanConvert] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    return fetch("/api/manage/leads")
      .then((r) => r.json())
      .then((d: LeadRow[]) => setRows(d.map((r) => ({ ...r, createdAt: formatDateTime(r.createdAt) }))));
  }

  useEffect(() => {
    load().catch(() => setRows([]));
    fetch("/api/manage/shell-info")
      .then((r) => r.json())
      .then((d: { role: string }) => setCanConvert(d.role === "BROKER_ADMIN"))
      .catch(() => {});
  }, []);

  const emptyNewLead = { fullName: "", email: "", phone: "", country: "", source: "", notes: "" };
  const [addOpen, setAddOpen] = useState(false);
  const [newLead, setNewLead] = useState(emptyNewLead);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [convertTarget, setConvertTarget] = useState<LeadRow | null>(null);
  const [convertPassword, setConvertPassword] = useState("");
  const [convertAccountType, setConvertAccountType] = useState<"DEMO" | "LIVE">("DEMO");
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertedCreds, setConvertedCreds] = useState<{ accountNumber: string; password: string } | null>(null);

  async function changeStatus(row: LeadRow, status: string) {
    setBusyId(row.id);
    await fetch(`/api/manage/leads/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    load().catch(() => {});
  }

  function openAdd() {
    setNewLead(emptyNewLead);
    setAddError(null);
    setAddOpen(true);
  }

  async function submitNewLead() {
    setAddBusy(true);
    setAddError(null);
    const response = await fetch("/api/manage/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newLead),
    });
    setAddBusy(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setAddError(b.error ?? "failed to add lead");
      return;
    }
    setAddOpen(false);
    load().catch(() => {});
  }

  function openConvert(row: LeadRow) {
    setConvertTarget(row);
    setConvertPassword("");
    setConvertAccountType("DEMO");
    setConvertError(null);
    setConvertedCreds(null);
  }

  async function submitConvert() {
    if (!convertTarget) return;
    if (convertPassword.length < 8) {
      setConvertError("Password must be at least 8 characters");
      return;
    }
    setConvertBusy(true);
    setConvertError(null);
    const accountResponse = await fetch("/api/manage/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: convertTarget.fullName,
        email: convertTarget.email,
        password: convertPassword,
        accountType: convertAccountType,
        phone: convertTarget.phone ?? undefined,
        country: convertTarget.country ?? undefined,
      }),
    });
    if (!accountResponse.ok) {
      const b = await accountResponse.json().catch(() => ({}));
      setConvertBusy(false);
      setConvertError(b.error ?? "failed to create account");
      return;
    }
    const created = await accountResponse.json();
    await fetch(`/api/manage/leads/${convertTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "CONVERTED", convertedAccountId: created.id }),
    });
    setConvertBusy(false);
    setConvertedCreds({ accountNumber: created.accountNumber, password: created.password });
    load().catch(() => {});
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--text-3)]">
          {rows.length} lead{rows.length === 1 ? "" : "s"} for this broker.
        </p>
        <Button onClick={openAdd}>Add lead</Button>
      </div>
      <Table>
        <TableHead>
          <TableHeaderCell>Lead</TableHeaderCell>
          <TableHeaderCell>Phone</TableHeaderCell>
          <TableHeaderCell>Country</TableHeaderCell>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableEmptyState colSpan={7}>No leads yet.</TableEmptyState>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell primary>
                  {row.fullName}
                  <div className="text-xs font-normal text-[var(--text-3)]">{row.email}</div>
                </TableCell>
                <TableCell>{row.phone ?? "—"}</TableCell>
                <TableCell>{row.country ?? "—"}</TableCell>
                <TableCell>{row.source ?? "—"}</TableCell>
                <TableCell>
                  {row.status === "CONVERTED" ? (
                    <div>
                      <Badge tone={statusTone.CONVERTED}>CONVERTED</Badge>
                      {row.convertedAccountNumber ? <div className="mt-0.5 text-xs text-[var(--text-3)] font-mono">{row.convertedAccountNumber}</div> : null}
                    </div>
                  ) : (
                    <Select value={row.status} disabled={busyId === row.id} onChange={(e) => changeStatus(row, e.target.value)} className="w-32">
                      <option value="NEW">NEW</option>
                      <option value="CONTACTED">CONTACTED</option>
                      <option value="QUALIFIED">QUALIFIED</option>
                      <option value="LOST">LOST</option>
                    </Select>
                  )}
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{row.createdAt}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {canConvert && row.status !== "CONVERTED" ? (
                    <Button size="sm" onClick={() => openConvert(row)}>
                      Convert
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add lead">
        <div className="flex flex-col gap-3">
          <FormField label="Full name">
            <Input value={newLead.fullName} onChange={(e) => setNewLead((p) => ({ ...p, fullName: e.target.value }))} />
          </FormField>
          <FormField label="Email">
            <Input type="email" value={newLead.email} onChange={(e) => setNewLead((p) => ({ ...p, email: e.target.value }))} />
          </FormField>
          <FormField label="Phone (optional)">
            <Input value={newLead.phone} onChange={(e) => setNewLead((p) => ({ ...p, phone: e.target.value }))} />
          </FormField>
          <FormField label="Country (optional)">
            <Input value={newLead.country} onChange={(e) => setNewLead((p) => ({ ...p, country: e.target.value }))} />
          </FormField>
          <FormField label="Source (optional)">
            <Input value={newLead.source} onChange={(e) => setNewLead((p) => ({ ...p, source: e.target.value }))} placeholder="e.g. Website, Referral" />
          </FormField>
          <FormField label="Notes (optional)">
            <Input value={newLead.notes} onChange={(e) => setNewLead((p) => ({ ...p, notes: e.target.value }))} />
          </FormField>
          {addError ? <p className="text-sm text-[var(--sell)]">{addError}</p> : null}
          <ModalActions>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={addBusy} onClick={submitNewLead}>
              {addBusy ? "Adding..." : "Add lead"}
            </Button>
          </ModalActions>
        </div>
      </Modal>

      <Modal open={convertTarget !== null} onClose={() => setConvertTarget(null)} title={`Convert lead — ${convertTarget?.fullName ?? ""}`}>
        {convertedCreds ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">Account created. This password is shown once — copy it now.</p>
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] p-3 font-mono text-sm">
              <div>Account: {convertedCreds.accountNumber}</div>
              <div>Password: {convertedCreds.password}</div>
            </div>
            <ModalActions>
              <Button variant="primary" onClick={() => setConvertTarget(null)}>
                Done
              </Button>
            </ModalActions>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-3)]">
              {convertTarget?.fullName} · {convertTarget?.email}
              {convertTarget?.phone ? ` · ${convertTarget.phone}` : ""}
              {convertTarget?.country ? ` · ${convertTarget.country}` : ""}
            </p>
            <FormField label="Account type">
              <Select value={convertAccountType} onChange={(e) => setConvertAccountType(e.target.value as "DEMO" | "LIVE")}>
                <option value="DEMO">DEMO</option>
                <option value="LIVE">LIVE</option>
              </Select>
            </FormField>
            <FormField label="Password (min 8 characters)">
              <Input type="text" mono value={convertPassword} onChange={(e) => setConvertPassword(e.target.value)} />
            </FormField>
            {convertError ? <p className="text-sm text-[var(--sell)]">{convertError}</p> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setConvertTarget(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={convertBusy} onClick={submitConvert}>
                {convertBusy ? "Converting..." : "Create account"}
              </Button>
            </ModalActions>
          </div>
        )}
      </Modal>
    </div>
  );
}
