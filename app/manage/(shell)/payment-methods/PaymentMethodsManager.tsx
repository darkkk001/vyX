"use client";

import { useEffect, useState } from "react";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell } from "@/components/ui/Table";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Button } from "@/components/ui/Button";

export type PaymentMethodType = "USDT_TRC20" | "USDT_BEP20" | "BTC" | "ETH" | "BANK_TRANSFER";

export type PaymentMethodRow = {
  id: string | null;
  type: PaymentMethodType;
  enabled: boolean;
  minAmount: string;
  maxAmount: string | null;
  feePercent: string;
  feeFixed: string;
  instructions: string | null;
  walletAddress: string | null;
};

const TYPE_LABELS: Record<PaymentMethodType, string> = {
  USDT_TRC20: "USDT (TRC20)",
  USDT_BEP20: "USDT (BEP20)",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BANK_TRANSFER: "Bank transfer",
};

const IS_CRYPTO: Record<PaymentMethodType, boolean> = {
  USDT_TRC20: true,
  USDT_BEP20: true,
  BTC: true,
  ETH: true,
  BANK_TRANSFER: false,
};

type EditableField = "minAmount" | "maxAmount" | "feePercent" | "feeFixed" | "walletAddress" | "instructions";

// Same "one row per type, all-defaults until saved, one Save button per
// row" pattern as app/manage/(shell)/symbols/SymbolConfigTable.tsx --
// see that file's own header comment. A type with no PaymentMethod row
// yet (id: null) shows disabled/zero-fee defaults; saving any field
// creates the row (PATCH upserts by the brokerId+type unique constraint,
// app/api/manage/payment-methods/route.ts).
export default function PaymentMethodsManager() {
  const [rows, setRows] = useState<PaymentMethodRow[] | null>(null);
  const [savingType, setSavingType] = useState<PaymentMethodType | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedType, setSavedType] = useState<PaymentMethodType | null>(null);

  useEffect(() => {
    fetch("/api/manage/payment-methods")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  function updateField(type: PaymentMethodType, field: EditableField, value: string) {
    setRows((prev) => prev && prev.map((r) => (r.type === type ? { ...r, [field]: value } : r)));
    setSavedType(null);
  }

  function toggleEnabled(type: PaymentMethodType) {
    setRows((prev) => prev && prev.map((r) => (r.type === type ? { ...r, enabled: !r.enabled } : r)));
    setSavedType(null);
  }

  async function save(row: PaymentMethodRow) {
    setSavingType(row.type);
    setErrors((prev) => ({ ...prev, [row.type]: "" }));

    const response = await fetch("/api/manage/payment-methods", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });

    setSavingType(null);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [row.type]: body.error ?? "save failed" }));
      return;
    }

    const updated = (await response.json()) as PaymentMethodRow;
    setRows((prev) => prev && prev.map((r) => (r.type === row.type ? { ...r, ...updated } : r)));
    setSavedType(row.type);
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <Table>
      <TableHead>
        <TableHeaderCell className="min-w-[150px]">Method</TableHeaderCell>
        <TableHeaderCell className="min-w-[70px]">Enabled</TableHeaderCell>
        <TableHeaderCell className="min-w-[90px]" title="Smallest amount a trader can request">Min amount</TableHeaderCell>
        <TableHeaderCell className="min-w-[90px]" title="Largest amount a trader can request -- blank = no limit">Max amount</TableHeaderCell>
        <TableHeaderCell className="min-w-[70px]" title="Shown to the trader as an estimate, not deducted from the ledgered amount">Fee %</TableHeaderCell>
        <TableHeaderCell className="min-w-[70px]" title="Shown to the trader as an estimate, not deducted from the ledgered amount">Fee fixed</TableHeaderCell>
        <TableHeaderCell className="min-w-[220px]">Wallet address / bank details</TableHeaderCell>
        <TableHeaderCell className="min-w-[220px]">Instructions</TableHeaderCell>
        <TableHeaderCell className="min-w-[140px]" />
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.type}>
            <TableCell primary className="min-w-[150px]">{TYPE_LABELS[row.type]}</TableCell>
            <TableCell className="min-w-[70px]">
              <Checkbox checked={row.enabled} onChange={() => toggleEnabled(row.type)} />
            </TableCell>
            <TableCell className="min-w-[90px]">
              <Input type="text" inputMode="decimal" mono value={row.minAmount} onChange={(e) => updateField(row.type, "minAmount", e.target.value)} style={{ width: 80 }} />
            </TableCell>
            <TableCell className="min-w-[90px]">
              <Input type="text" inputMode="decimal" mono placeholder="no limit" value={row.maxAmount ?? ""} onChange={(e) => updateField(row.type, "maxAmount", e.target.value)} style={{ width: 80 }} />
            </TableCell>
            <TableCell className="min-w-[70px]">
              <Input type="text" inputMode="decimal" mono value={row.feePercent} onChange={(e) => updateField(row.type, "feePercent", e.target.value)} style={{ width: 60 }} />
            </TableCell>
            <TableCell className="min-w-[70px]">
              <Input type="text" inputMode="decimal" mono value={row.feeFixed} onChange={(e) => updateField(row.type, "feeFixed", e.target.value)} style={{ width: 60 }} />
            </TableCell>
            <TableCell className="min-w-[220px]">
              {IS_CRYPTO[row.type] ? (
                <Input
                  type="text"
                  mono
                  placeholder="broker's deposit address"
                  value={row.walletAddress ?? ""}
                  onChange={(e) => updateField(row.type, "walletAddress", e.target.value)}
                  className="w-full"
                />
              ) : (
                <span className="text-xs text-[var(--text-3)]">Use Instructions for bank details</span>
              )}
            </TableCell>
            <TableCell className="min-w-[220px]">
              <Input
                type="text"
                placeholder={row.type === "BANK_TRANSFER" ? "Bank name, IBAN, SWIFT..." : "Shown to the trader alongside the address"}
                value={row.instructions ?? ""}
                onChange={(e) => updateField(row.type, "instructions", e.target.value)}
                className="w-full"
              />
            </TableCell>
            <TableCell className="min-w-[140px] whitespace-nowrap">
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={savingType === row.type} onClick={() => save(row)}>
                  {savingType === row.type ? "Saving..." : "Save"}
                </Button>
                {savedType === row.type ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
                {errors[row.type] ? <span className="text-xs text-[var(--sell)]">{errors[row.type]}</span> : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
