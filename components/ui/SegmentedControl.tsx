// A row of mutually-exclusive, radio-backed cards -- the same visual
// language PositionsManager.tsx's own reverse-mode picker already
// established (labeled cards, has-[:checked] border/bg), generalized
// into a shared primitive since the Add-account form needs two of these
// (Account mode: DEMO/LIVE; Account type: Standard/Pro/Zero) rather than
// two more one-off copies of the same markup.
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  name,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string | null }[];
  name: string;
}) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <label
          key={opt.value}
          className="flex-1 cursor-pointer rounded-lg border border-[var(--border)] p-2.5 text-center transition-colors has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-bg)]"
        >
          <input
            type="radio"
            name={name}
            className="sr-only"
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <div className="text-sm font-medium text-[var(--text-1)]">{opt.label}</div>
          {opt.hint ? <div className="mt-0.5 text-xs text-[var(--text-3)]">{opt.hint}</div> : null}
        </label>
      ))}
    </div>
  );
}
