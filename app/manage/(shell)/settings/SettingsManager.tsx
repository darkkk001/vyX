"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { LeverageInput } from "@/components/ui/LeverageInput";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal, ModalActions, ModalSection } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import { useToast } from "@/lib/toast";

type SettingsData = {
  name: string;
  subdomain: string;
  customDomain: string | null;
  tier: string;
  status: string;
  defaultAccountCurrency: string;
  defaultAccountLeverage: number;
};

// Same mapping as app/(super-admin)/(shell)/brokers/BrokersManager.tsx's
// own statusTone -- same BrokerStatus enum, same badge language.
const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;

type AccountTypeRow = {
  id: string;
  name: string;
  description: string | null;
  pricingHint: string | null;
  sortOrder: number;
  isDefault: boolean;
  enabled: boolean;
  // Storage-only pricing (2026-09-05) -- set/saved here, but no live
  // fill-time path reads these yet. See AccountType.spreadMarkup's own
  // schema comment for the full "config now, enforce later" reasoning.
  spreadMarkup: string;
  commissionPerLot: string;
  swapLong: string;
  swapShort: string;
  swapFree: boolean;
};

// Self-fetches from /api/manage/settings (a route that already returned
// exactly this combined broker+defaults shape, unmodified) instead of
// receiving broker/initial as server-rendered props -- both the website
// and a bundled manager-shell desktop app (no Server Component of its
// own) share this one path now.
export default function SettingsManager() {
  const { showToast } = useToast();
  const [data, setData] = useState<SettingsData | null>(null);
  const [currency, setCurrency] = useState("");
  const [leverage, setLeverage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manage/settings")
      .then((r) => r.json())
      .then((d: SettingsData) => {
        setData(d);
        setCurrency(d.defaultAccountCurrency);
        setLeverage(String(d.defaultAccountLeverage));
      })
      .catch(() => setError("failed to load"));
  }, []);

  // Account Types (pricing tier -- Standard/Pro/Zero, see
  // prisma/schema.prisma's AccountType model comment) CRUD.
  const [accountTypes, setAccountTypes] = useState<AccountTypeRow[] | null>(null);
  const [typeBusyId, setTypeBusyId] = useState<string | null>(null);

  function reloadAccountTypes() {
    return fetch("/api/manage/account-types")
      .then((r) => r.json())
      .then((d: AccountTypeRow[]) => setAccountTypes(d));
  }
  useEffect(() => {
    reloadAccountTypes().catch(() => setAccountTypes([]));
  }, []);

  const emptyTypeForm = {
    name: "",
    description: "",
    pricingHint: "",
    sortOrder: "0",
    isDefault: false,
    spreadMarkup: "0",
    commissionPerLot: "0",
    swapLong: "0",
    swapShort: "0",
    swapFree: false,
  };
  const [typeModalTarget, setTypeModalTarget] = useState<AccountTypeRow | "new" | null>(null);
  const [typeForm, setTypeForm] = useState(emptyTypeForm);
  const [typeFormError, setTypeFormError] = useState<string | null>(null);
  const [typeSaving, setTypeSaving] = useState(false);

  function openTypeModal(target: AccountTypeRow | "new") {
    setTypeModalTarget(target);
    setTypeFormError(null);
    setTypeForm(
      target === "new"
        ? emptyTypeForm
        : {
            name: target.name,
            description: target.description ?? "",
            pricingHint: target.pricingHint ?? "",
            sortOrder: String(target.sortOrder),
            isDefault: target.isDefault,
            spreadMarkup: target.spreadMarkup,
            commissionPerLot: target.commissionPerLot,
            swapLong: target.swapLong,
            swapShort: target.swapShort,
            swapFree: target.swapFree,
          }
    );
  }

  // Every PATCH here always resends every pricing field (not just the one
  // field this specific action changes) -- account-types/[id]/route.ts's
  // PATCH does fall back to the existing saved value for an ABSENT field,
  // but relying on that from every call site would mean one route change
  // silently controls whether toggleTypeEnabled/makeTypeDefault preserve
  // pricing; sending it explicitly here keeps that guarantee visible at
  // the call site instead.
  function pricingPayload(row: AccountTypeRow) {
    return {
      spreadMarkup: row.spreadMarkup,
      commissionPerLot: row.commissionPerLot,
      swapLong: row.swapLong,
      swapShort: row.swapShort,
      swapFree: row.swapFree,
    };
  }

  async function submitTypeForm() {
    if (!typeModalTarget) return;
    setTypeSaving(true);
    setTypeFormError(null);
    const isNew = typeModalTarget === "new";
    const url = isNew ? "/api/manage/account-types" : `/api/manage/account-types/${typeModalTarget.id}`;
    const response = await fetch(url, {
      method: isNew ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: typeForm.name,
        description: typeForm.description || undefined,
        pricingHint: typeForm.pricingHint || undefined,
        sortOrder: Number(typeForm.sortOrder) || 0,
        isDefault: typeForm.isDefault,
        spreadMarkup: typeForm.spreadMarkup,
        commissionPerLot: typeForm.commissionPerLot,
        swapLong: typeForm.swapLong,
        swapShort: typeForm.swapShort,
        swapFree: typeForm.swapFree,
      }),
    });
    setTypeSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setTypeFormError(b.error ?? "save failed");
      return;
    }
    setTypeModalTarget(null);
    reloadAccountTypes().catch(() => {});
    showToast(isNew ? "Account type created" : "Account type updated", "success");
  }

  async function toggleTypeEnabled(row: AccountTypeRow) {
    setTypeBusyId(row.id);
    const response = await fetch(`/api/manage/account-types/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: row.name,
        description: row.description,
        pricingHint: row.pricingHint,
        sortOrder: row.sortOrder,
        isDefault: row.isDefault,
        enabled: !row.enabled,
        ...pricingPayload(row),
      }),
    });
    setTypeBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      showToast(b.error ?? "update failed", "danger");
      return;
    }
    reloadAccountTypes().catch(() => {});
    showToast(`${row.name} ${row.enabled ? "disabled" : "enabled"}`, "success");
  }

  async function makeTypeDefault(row: AccountTypeRow) {
    setTypeBusyId(row.id);
    const response = await fetch(`/api/manage/account-types/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: row.name,
        description: row.description,
        pricingHint: row.pricingHint,
        sortOrder: row.sortOrder,
        isDefault: true,
        enabled: row.enabled,
        ...pricingPayload(row),
      }),
    });
    setTypeBusyId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      showToast(b.error ?? "update failed", "danger");
      return;
    }
    reloadAccountTypes().catch(() => {});
    showToast(`${row.name} is now the default`, "success");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    const response = await fetch("/api/manage/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAccountCurrency: currency, defaultAccountLeverage: leverage }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    const updated = await response.json();
    setData((prev) => (prev ? { ...prev, ...updated } : prev));
    setSaved(true);
  }

  if (!data) {
    return error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="Broker info" description="Read-only - edited in the Super Admin console.">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <dt className="text-[var(--text-3)]">Name</dt>
          <dd className="text-[var(--text-1)]">{data.name}</dd>
          <dt className="text-[var(--text-3)]">Subdomain</dt>
          <dd className="font-mono text-[var(--text-1)]">{data.subdomain}</dd>
          <dt className="text-[var(--text-3)]">Custom domain</dt>
          <dd className="font-mono text-[var(--text-1)]">{data.customDomain ?? "-"}</dd>
          <dt className="text-[var(--text-3)]">Tier</dt>
          <dd className="text-[var(--text-1)]">{data.tier}</dd>
          <dt className="text-[var(--text-3)]">Status</dt>
          <dd>
            <Badge tone={statusTone[data.status as keyof typeof statusTone] ?? "neutral"}>{data.status}</Badge>
          </dd>
        </dl>
      </Card>

      <Card title="Default account settings" description="Applied when Add Account doesn't specify currency/leverage.">
        <form onSubmit={save} className="flex flex-col gap-4">
          <FormField label="Default currency">
            <Input type="text" mono value={currency} onChange={(e) => { setCurrency(e.target.value); setSaved(false); }} className="max-w-xs" />
          </FormField>
          <FormField label="Default leverage">
            <LeverageInput value={leverage} onChange={(e) => { setLeverage(e.target.value); setSaved(false); }} className="max-w-xs" />
          </FormField>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
            {saved ? <span className="text-sm text-[var(--buy)]">Saved</span> : null}
          </div>
          {error ? <Alert tone="danger">{error}</Alert> : null}
        </form>
      </Card>

      <Card
        title="Account types"
        description="Pricing-tier labels a client account can be tagged with (Standard/Pro/Zero by default). Each type's own spread/commission/swap below is saved here now, but fill-time enforcement of a type's pricing (rather than the account's group) is a later pricing-engine phase -- Group pricing (Client groups page) is what actually applies to a real fill today."
        action={<Button size="sm" onClick={() => openTypeModal("new")}>+ Add type</Button>}
      >
        <Table>
          <TableHead>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Description</TableHeaderCell>
            <TableHeaderCell align="right">Spread</TableHeaderCell>
            <TableHeaderCell align="right">Commission</TableHeaderCell>
            <TableHeaderCell>Swap</TableHeaderCell>
            <TableHeaderCell align="right">Sort</TableHeaderCell>
            <TableHeaderCell>Default</TableHeaderCell>
            <TableHeaderCell>Enabled</TableHeaderCell>
            <TableHeaderCell />
          </TableHead>
          <TableBody>
            {accountTypes === null ? (
              <TableEmptyState colSpan={9}>Loading...</TableEmptyState>
            ) : accountTypes.length === 0 ? (
              <TableEmptyState colSpan={9}>No account types yet.</TableEmptyState>
            ) : (
              accountTypes.map((t) => (
                <TableRow key={t.id}>
                  <TableCell primary>{t.name}</TableCell>
                  <TableCell className="text-[var(--text-3)]">{t.description ?? "-"}</TableCell>
                  <TableCell align="right" mono>{t.spreadMarkup}p</TableCell>
                  <TableCell align="right" mono>${t.commissionPerLot}</TableCell>
                  <TableCell>
                    {t.swapFree ? (
                      <Badge tone="success">Swap-free</Badge>
                    ) : (
                      <span className="font-mono text-xs text-[var(--text-3)]">
                        L {t.swapLong} / S {t.swapShort}
                      </span>
                    )}
                  </TableCell>
                  <TableCell align="right" mono>{t.sortOrder}</TableCell>
                  <TableCell>
                    {t.isDefault ? (
                      <Badge tone="accent">Default</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" disabled={typeBusyId === t.id} onClick={() => makeTypeDefault(t)}>
                        Make default
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant={t.enabled ? "secondary" : "ghost"}
                      disabled={typeBusyId === t.id}
                      onClick={() => toggleTypeEnabled(t)}
                    >
                      {t.enabled ? "Enabled" : "Disabled"}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => openTypeModal(t)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Modal
        open={typeModalTarget !== null}
        onClose={() => setTypeModalTarget(null)}
        title={typeModalTarget === "new" ? "Add account type" : `Edit account type - ${typeModalTarget?.name ?? ""}`}
        onSubmit={submitTypeForm}
        wide
      >
        <div className="flex flex-col gap-3">
          <FormField label="Name">
            <Input value={typeForm.name} onChange={(e) => setTypeForm((p) => ({ ...p, name: e.target.value }))} />
          </FormField>
          <FormField label="Description (optional)">
            <Input value={typeForm.description} onChange={(e) => setTypeForm((p) => ({ ...p, description: e.target.value }))} />
          </FormField>
          <FormField label="Pricing hint (optional)">
            <Input
              placeholder="e.g. Spread-only, no commission"
              value={typeForm.pricingHint}
              onChange={(e) => setTypeForm((p) => ({ ...p, pricingHint: e.target.value }))}
            />
          </FormField>
          <FormField label="Sort order">
            <Input type="text" inputMode="numeric" mono value={typeForm.sortOrder} onChange={(e) => setTypeForm((p) => ({ ...p, sortOrder: e.target.value }))} />
          </FormField>
          <label className="flex items-center gap-2 text-sm text-[var(--text-1)]">
            <input type="checkbox" checked={typeForm.isDefault} onChange={(e) => setTypeForm((p) => ({ ...p, isDefault: e.target.checked }))} />
            Make this the default type for new accounts
          </label>

          <ModalSection label="Pricing">
            <Alert tone="info">
              Saved and shown here, but not yet applied to a real fill -- Group pricing (Client groups page) is what actually charges a real
              order today. Type-level pricing takes effect once the pricing engine (Phase 2) reads it.
            </Alert>
          </ModalSection>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Spread markup (pips)">
              <Input
                type="text"
                inputMode="decimal"
                mono
                value={typeForm.spreadMarkup}
                onChange={(e) => setTypeForm((p) => ({ ...p, spreadMarkup: e.target.value }))}
              />
            </FormField>
            <FormField label="Commission per lot">
              <Input
                type="text"
                inputMode="decimal"
                mono
                value={typeForm.commissionPerLot}
                onChange={(e) => setTypeForm((p) => ({ ...p, commissionPerLot: e.target.value }))}
              />
            </FormField>
            <FormField label="Swap long">
              <Input
                type="text"
                inputMode="decimal"
                mono
                disabled={typeForm.swapFree}
                value={typeForm.swapLong}
                onChange={(e) => setTypeForm((p) => ({ ...p, swapLong: e.target.value }))}
              />
            </FormField>
            <FormField label="Swap short">
              <Input
                type="text"
                inputMode="decimal"
                mono
                disabled={typeForm.swapFree}
                value={typeForm.swapShort}
                onChange={(e) => setTypeForm((p) => ({ ...p, swapShort: e.target.value }))}
              />
            </FormField>
          </div>
          <Checkbox
            label="Swap-free (e.g. Islamic account type)"
            title="No overnight swap/rollover charged on accounts of this type"
            checked={typeForm.swapFree}
            onChange={(e) => setTypeForm((p) => ({ ...p, swapFree: e.target.checked }))}
          />

          {typeFormError ? <Alert tone="danger">{typeFormError}</Alert> : null}
          <ModalActions>
            <Button type="button" variant="ghost" onClick={() => setTypeModalTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={typeSaving}>
              {typeSaving ? "Saving..." : typeModalTarget === "new" ? "Create type" : "Save changes"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}
