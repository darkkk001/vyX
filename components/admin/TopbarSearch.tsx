// Visual-only search box matching the mockup's topbar search. Deliberately
// `disabled` -- there is no real cross-entity search behind it yet (that's
// a new feature, out of scope for this restyle pass), and a disabled input
// is more honest than an enabled one that silently does nothing when you
// type into it.
export function TopbarSearch({ placeholder }: { placeholder: string }) {
  return (
    <div className="ml-3 flex w-72 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-1.5 opacity-70">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--text-3)]">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        placeholder={placeholder}
        disabled
        className="w-full bg-transparent text-xs text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] disabled:cursor-not-allowed"
      />
    </div>
  );
}
