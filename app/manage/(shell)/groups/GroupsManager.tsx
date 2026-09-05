"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { FormField } from "@/components/ui/FormField";
import { LeverageInput } from "@/components/ui/LeverageInput";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Modal, ModalActions, ModalSection } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";

export type GroupRow = {
  id: string;
  name: string;
  leverage: number;
  marginCallLevel: string;
  stopOutLevel: string;
  isDefault: boolean;
  maxLotSize: string;
  tradingRestriction: "BOTH" | "BUY_ONLY" | "SELL_ONLY";
  swapFree: boolean;
  forceDealingMode: boolean;
  groupType: "LP" | "DEALING" | "DEMO";
  dealingMode: "INHERIT" | "AUTO" | "MANUAL";
  tier: "STANDARD" | "PRO" | "ECN" | "ZERO";
  // Computed by the API from MirrorRule (sourceType=GROUP, sourceId=this
  // group's id) -- not a real Group column. See uiTypeFor below for why
  // this is what distinguishes the "Reverse (Mirror)" UI type from a
  // plain "Dealing" one; both persist identically as groupType=DEALING.
  hasMirrorRule: boolean;
};

// UI-only "Order routing" concept layered over groupType + dealingMode --
// there is no 4th GroupType enum value in the schema (LP | DEALING | DEMO
// only, see prisma/schema.prisma), and per the standing P2022 rule this
// redesign makes no schema change. Every option below persists as one of
// the real enum values; "B-Book (Auto)" and both DEALING-flavored options
// ("Dealing" / "Reverse (Mirror)") all persist as groupType=DEALING --
// what actually varies underneath is dealingMode (plus, for Reverse,
// whether a MirrorRule already sources from this group). "Reverse" is a
// real, already-used pattern in this broker's data (a DEALING group with
// a MirrorRule pointing away from it, direction=REVERSE), not a
// speculative addition.
//
// "Demo" is deliberately NOT one of these options (2026-09-05) -- Demo is
// an ACCOUNT MODE (Account.accountMode, set per account), not a routing
// choice: a demo account is simulated regardless of which group it's in,
// and routing only matters for live orders in the first place. Confirmed
// no fill/pricing/routing code branches on groupType==="DEMO" for
// anything simulation-related -- lib/group-pricing.ts's resolveBookType
// is the ONLY place that reads it at all, and treats DEMO identically to
// DEALING (both -> B_BOOK, since the function is only `=== "LP" ? A_BOOK
// : B_BOOK`), so uiTypeFor below folds a (currently nonexistent -- zero
// real groups have groupType=DEMO, confirmed by querying every broker)
// DEMO group into the "Dealing" option rather than needing a 5th choice.
type UiType = "BBOOK_AUTO" | "ABOOK_LP" | "DEALING" | "REVERSE_MIRROR";

function uiTypeFor(groupType: GroupRow["groupType"], dealingMode: GroupRow["dealingMode"], hasMirrorRule: boolean): UiType {
  if (groupType === "LP") return "ABOOK_LP";
  if (groupType !== "DEMO" && dealingMode === "AUTO") return "BBOOK_AUTO";
  return hasMirrorRule ? "REVERSE_MIRROR" : "DEALING";
}

const UI_TYPE_OPTIONS: { value: UiType; label: string; hint: string }[] = [
  {
    value: "BBOOK_AUTO",
    label: "B-Book (Auto)",
    hint: "Internalized, auto-fill: the broker holds the risk, no external routing.",
  },
  {
    value: "ABOOK_LP",
    label: "A-Book (LP)",
    hint: "Routed to the liquidity provider/bridge (external market hedge) -- the only routing that bridges directly.",
  },
  {
    value: "DEALING",
    label: "Dealing",
    hint: "Dealer queue: manual accept/reject, then internalized (no bridge).",
  },
  {
    value: "REVERSE_MIRROR",
    label: "Reverse (Mirror)",
    hint: "Orders are reversed into a master account; hedging/bridge happens from the master (indirect).",
  },
];

// Only DEALING and REVERSE_MIRROR route through the dealing desk at all,
// so only those two render this choice -- everything else (B-Book/Auto,
// LP, Demo) never shows it, which is what actually satisfies "Force
// Dealing only for DEALING-type groups." The old standalone checkbox is
// folded into dealingMode here instead of kept as a separate field:
// forceDealingMode is a no-op for a DEALING-type group in
// lib/dealing-routing.ts's resolveWantsDealingQueue (groupTypeIsDealing
// alone already satisfies the fallback OR there) -- dealingMode=MANUAL is
// the field that actually forces the queue unconditionally, so that's
// what "Force Dealing" maps to below.
const DEALING_CHOICE_OPTIONS: { value: "INHERIT" | "MANUAL"; label: string; hint: string }[] = [
  {
    value: "INHERIT",
    label: "Dealer-managed / direct",
    hint: "Follows the broker's Dealer switch (Dealing page): ON queues for manual review, OFF auto-fills at market.",
  },
  {
    value: "MANUAL",
    label: "Force Dealing",
    hint: "Every order from this group always queues for manual dealer approval, regardless of the Dealer switch.",
  },
];

const RESTRICTION_LABELS: Record<GroupRow["tradingRestriction"], string> = { BOTH: "Both", BUY_ONLY: "Buy only", SELL_ONLY: "Sell only" };

function routingBadge(row: GroupRow) {
  const uiType = uiTypeFor(row.groupType, row.dealingMode, row.hasMirrorRule);
  if (uiType === "BBOOK_AUTO") return <Badge tone="info">B-Book (Auto)</Badge>;
  if (uiType === "ABOOK_LP") return <Badge tone="accent">A-Book (LP)</Badge>;
  const dealingLabel = row.dealingMode === "MANUAL" ? "Force" : "Dealer-managed";
  return uiType === "REVERSE_MIRROR" ? (
    <Badge tone="warning">Reverse ({dealingLabel})</Badge>
  ) : (
    <Badge tone="success">Dealing ({dealingLabel})</Badge>
  );
}

// Read-only list + button-triggered create/edit modal, same fetch/error
// shape as SymbolConfigTable.tsx. Self-fetches from the already-existing
// /api/manage/groups GET instead of receiving initialRows as a
// server-rendered prop.
export default function GroupsManager() {
  const [rows, setRows] = useState<GroupRow[] | null>(null);
  const [formFor, setFormFor] = useState<{ mode: "create" } | { mode: "edit"; row: GroupRow } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manage/groups")
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  function handleCreated(created: GroupRow) {
    // Same "only one default" rule the API itself applies -- append the
    // row we got back directly instead of re-fetching the whole list.
    setRows((prev) => (created.isDefault ? (prev ?? []).map((r) => ({ ...r, isDefault: false })) : (prev ?? [])).concat(created));
  }

  function handleUpdated(updated: GroupRow) {
    setRows((prev) =>
      (prev ?? []).map((r) => {
        if (r.id === updated.id) return updated;
        return updated.isDefault ? { ...r, isDefault: false } : r;
      })
    );
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    const response = await fetch(`/api/manage/groups/${deleteTarget.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      // Stays open with the block reason visible (e.g. "N accounts are
      // assigned...") instead of closing on failure -- the whole point of
      // this guard is to make the admin actually read why, not just retry.
      setDeleteError(b.error ?? "delete failed");
      return;
    }
    setRows((prev) => (prev ?? []).filter((r) => r.id !== deleteTarget.id));
    setDeleteTarget(null);
  }

  if (rows === null) {
    return <p className="text-sm text-[var(--text-3)]">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Groups"
        action={
          <Button variant="primary" size="sm" onClick={() => setFormFor({ mode: "create" })}>
            + Create group
          </Button>
        }
      >
        <Table>
          <TableHead>
            <TableHeaderCell className="min-w-[150px]">Name</TableHeaderCell>
            <TableHeaderCell className="min-w-[110px]">Leverage</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[85px]">Margin call %</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[75px]">Stop out %</TableHeaderCell>
            <TableHeaderCell align="right" className="min-w-[75px]">Max lot</TableHeaderCell>
            <TableHeaderCell className="min-w-[95px]">Restriction</TableHeaderCell>
            <TableHeaderCell className="min-w-[175px]" title="How live orders from this group are routed">
              Routing
            </TableHeaderCell>
            <TableHeaderCell align="center" className="min-w-[80px]">Swap-free</TableHeaderCell>
            <TableHeaderCell align="center" className="min-w-[70px]">Default</TableHeaderCell>
            <TableHeaderCell className="min-w-[145px]" />
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableEmptyState colSpan={9}>No groups yet.</TableEmptyState>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell primary className="min-w-[150px]">
                    {row.name}
                  </TableCell>
                  <TableCell className="min-w-[110px]">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono">1:{row.leverage}</span>
                      <IconButton title="Edit leverage" onClick={() => setFormFor({ mode: "edit", row })}>
                        ✎
                      </IconButton>
                    </div>
                  </TableCell>
                  <TableCell align="right" mono className="min-w-[85px]">
                    {row.marginCallLevel}
                  </TableCell>
                  <TableCell align="right" mono className="min-w-[75px]">
                    {row.stopOutLevel}
                  </TableCell>
                  <TableCell align="right" mono className="min-w-[75px]">
                    {row.maxLotSize || "-"}
                  </TableCell>
                  <TableCell className="min-w-[95px]">{RESTRICTION_LABELS[row.tradingRestriction]}</TableCell>
                  <TableCell className="min-w-[175px]">{routingBadge(row)}</TableCell>
                  <TableCell align="center" className="min-w-[80px]">
                    {row.swapFree ? "✓" : "-"}
                  </TableCell>
                  <TableCell align="center" className="min-w-[70px]">
                    {row.isDefault ? "✓" : "-"}
                  </TableCell>
                  <TableCell className="min-w-[145px] whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => setFormFor({ mode: "edit", row })}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={row.isDefault}
                        title={row.isDefault ? "The default group cannot be deleted -- make another group the default first" : "Delete this group"}
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(row);
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {formFor ? (
        <GroupFormModal
          initial={formFor.mode === "edit" ? formFor.row : null}
          onClose={() => setFormFor(null)}
          onSaved={(saved) => {
            if (formFor.mode === "create") handleCreated(saved);
            else handleUpdated(saved);
            setFormFor(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <Modal open onClose={() => setDeleteTarget(null)} title={`Delete group: ${deleteTarget.name}`}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text-2)]">
              This deletes the group permanently. Its symbol allowlist and pricing overrides go with it. This can&apos;t be undone.
            </p>
            {deleteError ? <Alert tone="danger">{deleteError}</Alert> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={deleting} onClick={confirmDelete}>
                {deleting ? "Deleting..." : "Delete group"}
              </Button>
            </ModalActions>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

// Shared create/edit form -- context-aware: only the sections relevant to
// the selected order routing render at all (see UI_TYPE_OPTIONS/uiTypeFor
// above). Name/leverage/margin call/stop out/max lot/restriction/swap-
// free/default always show; the dealing-behavior choice and the mirror-
// rule note are type-conditional. Deliberately has NO tier/account-type
// field -- see submit()'s own comment on why that was removed. Same
// {initial, onClose, onSaved} self-fetching-free shape as SymbolsModal/
// PricingModal below, just with no GET (the row itself, or null for
// create, is all this needs).
function GroupFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: GroupRow | null;
  onClose: () => void;
  onSaved: (row: GroupRow) => void;
}) {
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  // Neutral-defaults rule (2026-09-05): a create form must never pre-pick
  // a real business value the admin didn't consciously choose -- leverage,
  // restriction, and order routing all start blank/unselected here
  // (native `required` below forces a real choice before submit). Margin
  // call %/stop out % keep their 100/50 seed values on purpose: those are
  // near-universal safety-rail conventions, not a business decision like
  // leverage or routing, so pre-filling them doesn't hide a real choice
  // the way defaulting to DEALING or 100x leverage would. Editing an existing
  // group is unaffected either way -- it always starts from that group's
  // own real saved values, never a "default."
  const [leverage, setLeverage] = useState(initial ? String(initial.leverage) : "");
  const [callLevel, setCallLevel] = useState(initial?.marginCallLevel ?? "100");
  const [stopOutLevel, setStopOutLevel] = useState(initial?.stopOutLevel ?? "50");
  const [maxLotSize, setMaxLotSize] = useState(initial?.maxLotSize ?? "");
  const [tradingRestriction, setTradingRestriction] = useState<GroupRow["tradingRestriction"] | "">(
    initial?.tradingRestriction ?? ""
  );
  const [swapFree, setSwapFree] = useState(initial?.swapFree ?? false);
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [uiType, setUiType] = useState<UiType | "">(
    initial ? uiTypeFor(initial.groupType, initial.dealingMode, initial.hasMirrorRule) : ""
  );
  const [dealingChoice, setDealingChoice] = useState<"INHERIT" | "MANUAL">(
    initial && initial.dealingMode === "MANUAL" ? "MANUAL" : "INHERIT"
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Symbols/Pricing only make sense for a group that already exists, so
  // these tabs are edit-only (see the create-mode "you can set up X after
  // creating this group" placeholders elsewhere in this file) -- a create
  // never has anything but "settings" to show.
  const [tab, setTab] = useState<"settings" | "symbols" | "pricing">("settings");

  const showsDealingChoice = uiType === "DEALING" || uiType === "REVERSE_MIRROR";

  async function submit() {
    setSaving(true);
    setError(null);
    // "Demo" is not a selectable routing option (see UI_TYPE_OPTIONS's own
    // comment) -- every routing choice this form can produce persists as
    // either LP or DEALING, never DEMO.
    const groupType: GroupRow["groupType"] = uiType === "ABOOK_LP" ? "LP" : "DEALING";
    const dealingMode: GroupRow["dealingMode"] = uiType === "BBOOK_AUTO" ? "AUTO" : showsDealingChoice ? dealingChoice : "INHERIT";
    const response = await fetch(isEdit ? `/api/manage/groups/${initial!.id}` : "/api/manage/groups", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        leverage,
        marginCallLevel: callLevel,
        stopOutLevel,
        isDefault,
        maxLotSize,
        tradingRestriction,
        swapFree,
        // The standalone "Force dealing" checkbox is fully retired -- every
        // real group in this broker's data already has this false, and its
        // only effect (forcing the queue for a non-DEALING group) is no
        // longer reachable through this form now that "Force Dealing" is
        // expressed as dealingMode=MANUAL under Dealing/Reverse instead.
        forceDealingMode: false,
        groupType,
        dealingMode,
        // Design fix (2026-09-05): this form used to expose Group.tier
        // (Standard/Pro/ECN/Zero) as a "Tier" field, which read as an
        // account-type/pricing-tier picker on a GROUP -- exactly the
        // "Group = routing, Account Type = pricing, they never mix"
        // confusion this fix removes. Confirmed no fill-time code reads
        // Group.tier at all (lib/group-pricing.ts's resolveSymbolPricing
        // only ever takes groupId, never a tier or accountTypeId) -- it
        // really was just a same-named, purposeless-today classification
        // field, per its own schema comment. The column stays (no schema
        // change here), but nothing in this form shows or sets it
        // anymore; passing the group's own existing value straight
        // through on edit (instead of a hidden state variable) means an
        // edit can never silently change it to something the admin never
        // touched, and omitting it on create lets the API's own default
        // (STANDARD) apply to a value nothing reads anyway.
        ...(isEdit ? { tier: initial!.tier } : {}),
      }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    const saved: GroupRow = await response.json();
    onSaved(saved);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit group: ${initial!.name}` : "Create group"}
      onSubmit={tab === "settings" ? submit : undefined}
      wide={!isEdit}
      xl={isEdit}
    >
      <div className="flex flex-col gap-4">
        {isEdit ? (
          <div className="-mt-1 flex gap-1 border-b border-[var(--border)]">
            {(
              [
                ["settings", "Settings"],
                ["symbols", "Symbols"],
                ["pricing", "Pricing"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                  tab === id
                    ? "border-[var(--accent)] text-[var(--text-1)]"
                    : "border-transparent text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "symbols" && isEdit ? <SymbolsPanel groupId={initial!.id} /> : null}
        {tab === "pricing" && isEdit ? <PricingPanel groupId={initial!.id} groupName={initial!.name} /> : null}

        {tab === "settings" ? (
          <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <FormField label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </FormField>
          <FormField label="Leverage">
            <LeverageInput value={leverage} onChange={(e) => setLeverage(e.target.value)} placeholder="e.g. 100" required />
          </FormField>
          <FormField label="Margin call %">
            <Input type="text" inputMode="decimal" mono value={callLevel} onChange={(e) => setCallLevel(e.target.value)} />
          </FormField>
          <FormField label="Stop out %">
            <Input type="text" inputMode="decimal" mono value={stopOutLevel} onChange={(e) => setStopOutLevel(e.target.value)} />
          </FormField>
          <FormField label="Max lot">
            <Input
              type="text"
              inputMode="decimal"
              mono
              placeholder="blank = no override"
              value={maxLotSize}
              onChange={(e) => setMaxLotSize(e.target.value)}
            />
          </FormField>
          <FormField label="Trading restriction">
            <Select
              value={tradingRestriction}
              onChange={(e) => setTradingRestriction(e.target.value as GroupRow["tradingRestriction"])}
              required
            >
              <option value="" disabled>
                Select restriction...
              </option>
              <option value="BOTH">Both</option>
              <option value="BUY_ONLY">Buy only</option>
              <option value="SELL_ONLY">Sell only</option>
            </Select>
          </FormField>
        </div>

        <div className="flex flex-wrap items-center gap-5">
          <Checkbox
            label="Swap-free"
            title="No overnight swap/rollover charged on positions held in this group"
            checked={swapFree}
            onChange={(e) => setSwapFree(e.target.checked)}
          />
          <Checkbox
            label="Default group"
            title="New accounts are placed in this group automatically when no group is chosen at creation"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
        </div>

        <ModalSection label="Order routing">
          <p className="mb-1.5 text-xs text-[var(--text-3)]">How live orders from this group are routed.</p>
          <Select value={uiType} onChange={(e) => setUiType(e.target.value as UiType)} required>
            <option value="" disabled>
              Select order routing...
            </option>
            {UI_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
          {uiType ? (
            <p className="mt-1.5 text-xs text-[var(--text-3)]">{UI_TYPE_OPTIONS.find((o) => o.value === uiType)?.hint}</p>
          ) : null}
        </ModalSection>

        {uiType === "ABOOK_LP" ? (
          <ModalSection label="LP connection">
            <Alert tone="info">
              LP routing config isn&apos;t built yet (Phase 5) -- orders in this group are marked A-Book but still execute against the
              simulated/blended price feed until a real liquidity-provider connection exists.
            </Alert>
          </ModalSection>
        ) : null}

        {showsDealingChoice ? (
          <ModalSection label="Dealing behavior">
            <SegmentedControl value={dealingChoice} onChange={setDealingChoice} options={DEALING_CHOICE_OPTIONS} name="dealingChoice" />
          </ModalSection>
        ) : null}

        {uiType === "REVERSE_MIRROR" ? (
          <ModalSection label="Mirror rule">
            {isEdit && initial!.hasMirrorRule ? (
              <Alert tone="success">A mirror rule already sources from this group. Manage it from Dealing → Mirror Rules.</Alert>
            ) : (
              <Alert tone="warning">
                {isEdit ? "No mirror rule sources from this group yet." : "You can set up the mirror rule after creating this group."} Configure
                it from Dealing → Mirror Rules (source = this group, direction = Reverse).
              </Alert>
            )}
          </ModalSection>
        ) : null}

        {error ? <p className="text-sm text-[var(--sell)]">{error}</p> : null}
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving..." : isEdit ? "Save" : "Create group"}
          </Button>
        </ModalActions>
          </>
        ) : (
          <ModalActions>
            <Button type="button" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </ModalActions>
        )}
      </div>
    </Modal>
  );
}

type SymbolOption = { id: string; name: string; category: string };
type GroupSymbolsData = { restrictSymbols: boolean; allowedSymbolIds: string[]; availableSymbols: SymbolOption[] };

// Opt-in per-group symbol allowlist -- unchecked (restrictSymbols=false)
// is the default every group already had before this existed, so
// nothing changes for a group until an admin deliberately turns this on
// here. See lib/risk.ts's checkGroupAllowedSymbol for the enforcement
// side, and app/api/manage/symbols/[id]/sessions/route.ts's Sessions
// modal (SymbolConfigTable.tsx) for the "replace whole list" precedent
// this mirrors. Lives inside the group's own Edit modal as a tab (not a
// standalone popup on the main Groups page) -- a group's symbol/pricing
// config is that group's own setting, configured where the rest of the
// group's settings are, not scattered across the page as separate
// always-visible actions.
function SymbolsPanel({ groupId }: { groupId: string }) {
  const [data, setData] = useState<GroupSymbolsData | null>(null);
  const [restrictSymbols, setRestrictSymbols] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/manage/groups/${groupId}/symbols`)
      .then((r) => r.json())
      .then((d: GroupSymbolsData) => {
        setData(d);
        setRestrictSymbols(d.restrictSymbols);
        setSelected(new Set(d.allowedSymbolIds));
      })
      .catch(() => setError("failed to load"));
  }, [groupId]);

  function toggleSymbol(symbolId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbolId)) next.delete(symbolId);
      else next.add(symbolId);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const response = await fetch(`/api/manage/groups/${groupId}/symbols`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restrictSymbols, symbolIds: Array.from(selected) }),
    });
    setSaving(false);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setError(b.error ?? "save failed");
      return;
    }
    setSaved(true);
  }

  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        label="Restrict this group to only the symbols checked below"
        checked={restrictSymbols}
        onChange={(e) => {
          setRestrictSymbols(e.target.checked);
          setSaved(false);
        }}
      />
      <p className="text-xs text-[var(--text-3)]">
        {restrictSymbols
          ? "Accounts in this group can only trade the symbols checked below. An order in any other symbol is rejected."
          : "Unchecked (default): accounts in this group can trade every enabled symbol, same as before this feature existed."}
      </p>
      {data === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : data.availableSymbols.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No symbols enabled yet. Enable some on the Symbols page first.</p>
      ) : (
        <div className="grid max-h-80 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-lg border border-[var(--border)] p-3 sm:grid-cols-3">
          {data.availableSymbols.map((s) => (
            <Checkbox key={s.id} label={s.name} checked={selected.has(s.id)} onChange={() => toggleSymbol(s.id)} />
          ))}
        </div>
      )}
      {error ? <p className="text-sm text-[var(--sell)]">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button type="button" variant="primary" disabled={saving || data === null} onClick={save}>
          {saving ? "Saving..." : "Save symbols"}
        </Button>
        {saved ? <span className="text-xs text-[var(--buy)]">Saved</span> : null}
      </div>
    </div>
  );
}

type PricingRow = {
  symbolId: string;
  symbolName: string;
  category: string;
  hasOverride: boolean;
  spreadMarkup: string;
  commissionPerLot: string;
  swapLong: string;
  swapShort: string;
};

// Per-group-per-symbol pricing override -- see GroupSymbolConfig's own
// schema comment and lib/group-pricing.ts's resolveSymbolPricing for how
// these values are actually applied at fill time (real spread markup and
// commission, unlike BrokerSymbol's own broker-wide values, which the
// live Next.js trading path doesn't read at all). A row with no override
// shows the broker-wide default (same "missing config = defaults"
// convention as SymbolConfigTable itself) -- saving one creates a
// group-specific row, Reset removes it, falling back to the broker
// default again. Lives inside the group's own Edit modal as a tab, same
// reasoning as SymbolsPanel above.
//
// Overflow fix (2026-09-05): this table used to render inside a 600px
// modal at the shared Table primitive's default px-4 cell padding -- 6
// columns of that padding alone (192px) plus 4 real input boxes left no
// room to fit without the table's own horizontal scrollbar kicking in
// for every group, not just wide ones. The parent modal is now `xl`
// (880px) specifically for this tab, and the padding/input widths here
// are tightened further (px-3, narrower swap columns) on top of that for
// real headroom -- scoped to just this table via className overrides, so
// every other page's Table keeps its normal spacing.
function PricingPanel({ groupId, groupName }: { groupId: string; groupName: string }) {
  const [rows, setRows] = useState<PricingRow[] | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`/api/manage/groups/${groupId}/pricing`)
      .then((r) => r.json())
      .then(setRows)
      .catch(() => setRows([]));
  }, [groupId]);

  function updatePricingRow(symbolId: string, patch: Partial<PricingRow>) {
    setRows((prev) => prev && prev.map((r) => (r.symbolId === symbolId ? { ...r, ...patch } : r)));
  }

  async function save(pr: PricingRow) {
    setSavingId(pr.symbolId);
    setErrors((prev) => ({ ...prev, [pr.symbolId]: "" }));
    const response = await fetch(`/api/manage/groups/${groupId}/pricing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbolId: pr.symbolId,
        spreadMarkup: pr.spreadMarkup,
        commissionPerLot: pr.commissionPerLot,
        swapLong: pr.swapLong,
        swapShort: pr.swapShort,
      }),
    });
    setSavingId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [pr.symbolId]: b.error ?? "save failed" }));
      return;
    }
    updatePricingRow(pr.symbolId, { hasOverride: true });
  }

  async function reset(pr: PricingRow) {
    setSavingId(pr.symbolId);
    setErrors((prev) => ({ ...prev, [pr.symbolId]: "" }));
    const response = await fetch(`/api/manage/groups/${groupId}/pricing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbolId: pr.symbolId, reset: true }),
    });
    setSavingId(null);
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      setErrors((prev) => ({ ...prev, [pr.symbolId]: b.error ?? "reset failed" }));
      return;
    }
    const reverted = await response.json();
    updatePricingRow(pr.symbolId, {
      hasOverride: false,
      spreadMarkup: reverted.spreadMarkup,
      commissionPerLot: reverted.commissionPerLot,
      swapLong: reverted.swapLong,
      swapShort: reverted.swapShort,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--text-3)]">
        Spread markup and commission set here apply to every real order fill for accounts in {groupName}, not just a label. A symbol with no
        saved override yet shows the platform default (matching the Symbols page); saving creates a group-specific row, Reset removes it.
      </p>
      {rows === null ? (
        <p className="text-sm text-[var(--text-3)]">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--text-3)]">No symbols enabled yet. Enable some on the Symbols page first.</p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHead>
              <TableHeaderCell className="!px-3">Symbol</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Spread</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Commission</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Swap L</TableHeaderCell>
              <TableHeaderCell align="right" className="!px-3">Swap S</TableHeaderCell>
              <TableHeaderCell className="!px-3" />
            </TableHead>
            <TableBody>
              {rows.map((pr) => (
                <TableRow key={pr.symbolId}>
                  <TableCell mono className="!px-3">
                    {pr.symbolName}
                    {!pr.hasOverride ? <div className="text-xs text-[var(--text-3)]">broker default</div> : null}
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={pr.spreadMarkup}
                      onChange={(e) => updatePricingRow(pr.symbolId, { spreadMarkup: e.target.value })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={pr.commissionPerLot}
                      onChange={(e) => updatePricingRow(pr.symbolId, { commissionPerLot: e.target.value })}
                      className="w-20 text-right"
                    />
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={pr.swapLong}
                      onChange={(e) => updatePricingRow(pr.symbolId, { swapLong: e.target.value })}
                      className="w-16 text-right"
                    />
                  </TableCell>
                  <TableCell align="right" className="!px-3">
                    <Input
                      type="text"
                      inputMode="decimal"
                      mono
                      value={pr.swapShort}
                      onChange={(e) => updatePricingRow(pr.symbolId, { swapShort: e.target.value })}
                      className="w-16 text-right"
                    />
                  </TableCell>
                  <TableCell className="!px-3 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" disabled={savingId === pr.symbolId} onClick={() => save(pr)}>
                        {savingId === pr.symbolId ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={savingId === pr.symbolId || !pr.hasOverride} onClick={() => reset(pr)}>
                        Reset
                      </Button>
                    </div>
                    {errors[pr.symbolId] ? <div className="mt-1 text-xs text-[var(--sell)]">{errors[pr.symbolId]}</div> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
