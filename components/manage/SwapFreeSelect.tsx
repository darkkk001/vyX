import { Select } from "@/components/ui/Select";

// Shared tri-state swap-free control -- Account.swapFree, AccountType.
// swapFree, and Group.swapFree are all nullable booleans since the
// 2026-09-07 migration, resolved account > type > group > false
// (lib/pricing-engine.ts). null must be a real, selectable option here
// (not just "unchecked"), which is why this is a 3-option Select rather
// than the plain Checkbox all three forms used before Stage 5 -- a
// checkbox has no way to represent "inherit," only true/false.
export function SwapFreeSelect({
  value,
  onChange,
  inheritLabel = "Inherit",
  disabled,
}: {
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  inheritLabel?: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value === null ? "inherit" : value ? "true" : "false"}
      onChange={(e) => onChange(e.target.value === "inherit" ? null : e.target.value === "true")}
      disabled={disabled}
    >
      <option value="inherit">{inheritLabel}</option>
      <option value="true">Swap-free</option>
      <option value="false">Charge swap</option>
    </Select>
  );
}
