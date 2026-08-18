import type { BrokerTier } from "@prisma/client";

// Config-only plan pricing -- not wired to any real payment processor.
// Single source of truth for the price labels that used to be hardcoded
// strings in CreateBrokerForm.tsx's <Select> options, now also reused by
// the Super Admin Billing page's MRR calculation.
export const PLAN_PRICING: Record<BrokerTier, { label: string; monthlyCents: number }> = {
  STANDARD: { label: "Standard", monthlyCents: 50000 },
  WHITE_LABEL: { label: "White-Label", monthlyCents: 80000 },
};

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
