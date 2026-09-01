"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

type RuleRow = {
  id: string;
  sourceType: "GROUP" | "ACCOUNT";
  sourceId: string;
  sourceLabel: string;
  targetAccountId: string;
  targetAccountLabel: string;
  direction: "REVERSE" | "SAME";
  multiplier: string;
  symbolFilter: string | null;
  maxOpenLots: string | null;
  maxDailyLoss: string | null;
  enabled: boolean;
  killedAt: string | null;
  status: "ACTIVE" | "KILLED" | "DISABLED";
  failureCount: number;
  createdByEmail: string;
  createdAt: string;
};

type PickerGroup = { id: string; name: string };
type PickerAccount = { id: string; accountNumber: string; fullName: string; hasKyc: boolean };

type DetailPosition = {
  sourcePositionId: string;
  targetPositionId: string;
  symbol: string | null;
  sourceSide: "BUY" | "SELL" | null;
  sourceVolume: string | null;
  sourceStatus: string | null;
  sourcePnl: string | null;
  targetSide: "BUY" | "SELL" | null;
  targetVolume: string | null;
  targetStatus: string | null;
  targetPnl: string | null;
};

const STATUS_TONE = { ACTIVE: "success", KILLED: "danger", DISABLED: "neutral" } as const;

const emptyForm = {
  sourceType: "GROUP" as "GROUP" | "ACCOUNT",
  sourceId: "",
  targetAccountId: "",
  direction: "REVERSE" as "REVERSE" | "SAME",
  multiplier: "1",
  symbolFilter: "",
  maxOpenLots: "",
  maxDailyLoss: "",
};

// Institutional-style Dealing -> Mirror tab (docs/briefs/
// VYX-MIRROR-V0-BRIEF.md). Self-fetches from /api/manage/mirror-rules,
// same pattern as every other Manager page in this app.
export default function MirrorRulesManager() {
  const [rows, setRows] = useState<RuleRow[] | null>(null);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [accounts, setAccounts] = useState<PickerAccount[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  function load() {
    return fetch("/api/manage/mirror-rules")
      .then((r) => r.json())
      .then((d: { rows: RuleRow[]; groups: PickerGroup[]; accounts: PickerAccount[] }) => {
        setRows(d.rows);
        setGroups(d.groups);
        setAccounts(d.accounts);
      });
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function toggleEnabled(rule: RuleRow) {
    setBusyId(rule.id);
    try {
      await fetch(`/api/manage/mirror-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setForm(emptyForm);
    setFormError(null);
    setCreateOpen(true);
  }

  async function submitCreate() {
    if (!form.sourceId || !form.targetAccountId) {
      setFormError("Pick both a source and a target account.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/manage/mirror-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceType: form.sourceType,
          sourceId: form.sourceId,
          targetAccountId: form.targetAccountId,
          direction: form.direction,
          multiplier: form.multiplier,
          symbolFilter: form.symbolFilter,
          maxOpenLots: form.maxOpenLots,
          maxDailyLoss: form.maxDailyLoss,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFormError(body.error ?? "Failed to create rule.");
        return;
      }
      setCreateOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  const targetAccount = accounts.find((a) => a.id === form.targetAccountId);

  return (
    <div className="flex flex-col gap-4">
      <Table
        title="Mirror rules"
        description="Trades from a source group/account are mirrored onto a target account, automatically."
        action={<Button onClick={openCreate}>New rule</Button>}
      >
        <TableHead>
          <TableHeaderCell>Source</TableHeaderCell>
          <TableHeaderCell>Target</TableHeaderCell>
          <TableHeaderCell>Direction</TableHeaderCell>
          <TableHeaderCell align="right">Multiplier</TableHeaderCell>
          <TableHeaderCell>Caps</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell align="right">Failures</TableHeaderCell>
          <TableHeaderCell>Created by</TableHeaderCell>
          <TableHeaderCell></TableHeaderCell>
        </TableHead>
        <TableBody>
          {rows === null ? (
            <TableEmptyState colSpan={9}>Loading…</TableEmptyState>
          ) : rows.length === 0 ? (
            <TableEmptyState colSpan={9}>No mirror rules yet.</TableEmptyState>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                <TableCell primary>
                  {r.sourceType === "GROUP" ? "Group: " : "Account: "}
                  {r.sourceLabel}
                </TableCell>
                <TableCell>{r.targetAccountLabel}</TableCell>
                <TableCell>
                  <Badge tone={r.direction === "REVERSE" ? "accent" : "info"}>{r.direction === "REVERSE" ? "Reverse" : "Same"}</Badge>
                </TableCell>
                <TableCell align="right" mono>×{r.multiplier}</TableCell>
                <TableCell mono className="text-xs">
                  {r.maxOpenLots ? `${r.maxOpenLots} lots` : "—"}
                  {r.maxDailyLoss ? ` / -${r.maxDailyLoss}` : ""}
                </TableCell>
                <TableCell>
                  <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                </TableCell>
                <TableCell align="right" mono>{r.failureCount}</TableCell>
                <TableCell className="text-xs">{r.createdByEmail}</TableCell>
                <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="sm"
                    variant={r.enabled ? "danger" : "success"}
                    loading={busyId === r.id}
                    onClick={() => toggleEnabled(r)}
                  >
                    {r.enabled ? "Disable" : r.status === "KILLED" ? "Re-enable" : "Enable"}
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New mirror rule" wide>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Source type">
            <select
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3 py-2 text-sm text-[var(--text-1)]"
              value={form.sourceType}
              onChange={(e) => setForm((f) => ({ ...f, sourceType: e.target.value as "GROUP" | "ACCOUNT", sourceId: "" }))}
            >
              <option value="GROUP">Group</option>
              <option value="ACCOUNT">Account</option>
            </select>
          </FormField>
          <FormField label={form.sourceType === "GROUP" ? "Source group" : "Source account"}>
            <select
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3 py-2 text-sm text-[var(--text-1)]"
              value={form.sourceId}
              onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
            >
              <option value="">Select…</option>
              {form.sourceType === "GROUP"
                ? groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)
                : accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} — {a.fullName}</option>)}
            </select>
          </FormField>
          <FormField label="Target account (master)">
            <select
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3 py-2 text-sm text-[var(--text-1)]"
              value={form.targetAccountId}
              onChange={(e) => setForm((f) => ({ ...f, targetAccountId: e.target.value }))}
            >
              <option value="">Select…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} — {a.fullName}</option>)}
            </select>
          </FormField>
          <FormField label="Direction">
            <select
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3 py-2 text-sm text-[var(--text-1)]"
              value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as "REVERSE" | "SAME" }))}
            >
              <option value="REVERSE">Reverse (BUY↔SELL)</option>
              <option value="SAME">Same side</option>
            </select>
          </FormField>
          <FormField label="Multiplier (lot scale)">
            <Input value={form.multiplier} onChange={(e) => setForm((f) => ({ ...f, multiplier: e.target.value }))} placeholder="1" />
          </FormField>
          <FormField label="Symbol filter (CSV, blank = all)">
            <Input value={form.symbolFilter} onChange={(e) => setForm((f) => ({ ...f, symbolFilter: e.target.value }))} placeholder="XAUUSD,EURUSD" />
          </FormField>
          <FormField label="Max open lots on target (blank = no cap)">
            <Input value={form.maxOpenLots} onChange={(e) => setForm((f) => ({ ...f, maxOpenLots: e.target.value }))} placeholder="10" />
          </FormField>
          <FormField label="Max daily loss on target (blank = no cap)">
            <Input value={form.maxDailyLoss} onChange={(e) => setForm((f) => ({ ...f, maxDailyLoss: e.target.value }))} placeholder="1000" />
          </FormField>
        </div>
        {targetAccount?.hasKyc ? (
          <p className="mt-3 rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-xs text-[var(--warn)]">
            This target account has a KYC record on file — it looks like a real client account. A dedicated master
            account (no KYC, not traded manually) is recommended for mirror targets.
          </p>
        ) : null}
        {formError ? <p className="mt-3 text-sm text-[var(--sell)]">{formError}</p> : null}
        <ModalActions>
          <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button onClick={submitCreate} loading={saving}>Create rule</Button>
        </ModalActions>
      </Modal>

      {detailId ? <MirrorRuleDetail id={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}

function MirrorRuleDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<{
    rule: RuleRow;
    positions: DetailPosition[];
    netStrategyPnl: string | null;
    recentFailures: { createdAt: string; reason: string | null }[];
  } | null>(null);

  useEffect(() => {
    fetch(`/api/manage/mirror-rules/${id}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, [id]);

  return (
    <Modal open onClose={onClose} title="Mirror rule detail" wide>
      {!data ? (
        <p className="text-sm text-[var(--text-3)]">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">Source</div>
              <div className="text-[var(--text-1)]">{data.rule.sourceLabel}</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">Target</div>
              <div className="text-[var(--text-1)]">{data.rule.targetAccountLabel}</div>
            </div>
            <div>
              <div className="text-[10.5px] uppercase tracking-wide text-[var(--text-3)]">Net strategy P/L</div>
              <div className={`font-mono ${data.netStrategyPnl && Number(data.netStrategyPnl) < 0 ? "text-[var(--sell)]" : "text-[var(--buy)]"}`}>
                {data.netStrategyPnl ?? "— (no live price)"}
              </div>
            </div>
          </div>

          <Table title="Mirrored positions">
            <TableHead>
              <TableHeaderCell>Symbol</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell align="right">Source P/L</TableHeaderCell>
              <TableHeaderCell>Target</TableHeaderCell>
              <TableHeaderCell align="right">Target P/L</TableHeaderCell>
            </TableHead>
            <TableBody>
              {data.positions.length === 0 ? (
                <TableEmptyState colSpan={5}>No mirrored positions yet.</TableEmptyState>
              ) : (
                data.positions.map((p) => (
                  <TableRow key={p.sourcePositionId}>
                    <TableCell primary>{p.symbol ?? "—"}</TableCell>
                    <TableCell mono>{p.sourceSide} {p.sourceVolume} ({p.sourceStatus})</TableCell>
                    <TableCell align="right" mono>{p.sourcePnl ?? "—"}</TableCell>
                    <TableCell mono>{p.targetSide} {p.targetVolume} ({p.targetStatus})</TableCell>
                    <TableCell align="right" mono>{p.targetPnl ?? "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <Table title="Recent failures">
            <TableHead>
              <TableHeaderCell>When</TableHeaderCell>
              <TableHeaderCell>Reason</TableHeaderCell>
            </TableHead>
            <TableBody>
              {data.recentFailures.length === 0 ? (
                <TableEmptyState colSpan={2}>No failures logged.</TableEmptyState>
              ) : (
                data.recentFailures.map((f, i) => (
                  <TableRow key={i}>
                    <TableCell mono className="text-xs">{f.createdAt.replace("T", " ").slice(0, 19)}</TableCell>
                    <TableCell className="text-xs">{f.reason ?? "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
      <ModalActions>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </ModalActions>
    </Modal>
  );
}
