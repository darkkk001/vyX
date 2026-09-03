"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type SearchResults = {
  accounts: { id: string; accountNumber: string; fullName: string; email: string; accountType: string }[];
  orders: { id: string; accountId: string; accountNumber: string; symbol: string; side: string; type: string; status: string }[];
  positions: { id: string; accountId: string; accountNumber: string; symbol: string; side: string; status: string }[];
  transactions: { id: string; accountId: string; accountNumber: string; type: string; status: string; amount: string }[];
  symbols: { id: string; name: string; category: string }[];
};

const EMPTY: SearchResults = { accounts: [], orders: [], positions: [], transactions: [], symbols: [] };
const RECENT_KEY = "vyx-manager-recent-searches";
const RECENT_MAX = 5;

type FlatItem = {
  key: string;
  badge: string;
  badgeClass: string;
  label: string;
  sublabel: string;
  path: string;
};

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecent(query: string) {
  try {
    const existing = loadRecent().filter((q) => q.toLowerCase() !== query.toLowerCase());
    window.localStorage.setItem(RECENT_KEY, JSON.stringify([query, ...existing].slice(0, RECENT_MAX)));
  } catch {
    // localStorage unavailable (private mode) -- recent searches just won't persist
  }
}

// Real cross-entity search (VYX-BACKOFFICE-SEARCH-V0), replacing the
// previous disabled placeholder input. Debounced against
// /api/manage/search; grouped results with a type badge per row,
// keyboard-navigable (Up/Down/Enter/Escape), recent searches shown when
// the box is empty. Deliberately navigates via window.location.href, not
// next/navigation's router -- this component also bundles into
// manager-tauri's Vite shell (see App.tsx), which has no Next.js router
// to satisfy, so a plain browser navigation is the one thing guaranteed
// to work in both places.
export function TopbarSearch({ placeholder }: { placeholder: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setRecent(loadRecent());
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++requestSeqRef.current;
    debounceRef.current = setTimeout(() => {
      fetch(`/api/manage/search?q=${encodeURIComponent(trimmed)}`)
        .then((r) => (r.ok ? r.json() : EMPTY))
        .then((data: SearchResults) => {
          // Stale-response guard -- a slower earlier request resolving
          // after a faster later one would otherwise flash outdated
          // results back onto the screen for whatever's currently typed.
          if (seq === requestSeqRef.current) setResults(data);
        })
        .catch(() => { if (seq === requestSeqRef.current) setResults(EMPTY); })
        .finally(() => { if (seq === requestSeqRef.current) setLoading(false); });
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const flat: FlatItem[] = useMemo(() => {
    const items: FlatItem[] = [];
    for (const a of results.accounts) {
      items.push({
        key: `account-${a.id}`,
        badge: "Account",
        badgeClass: "bg-[var(--accent-bg)] text-[var(--accent)]",
        label: `${a.accountNumber} — ${a.fullName}`,
        sublabel: `${a.email} · ${a.accountType}`,
        path: `/manage/accounts/${a.id}`,
      });
    }
    for (const o of results.orders) {
      items.push({
        key: `order-${o.id}`,
        badge: "Order",
        badgeClass: "bg-[var(--blue-bg,rgba(91,157,240,0.12))] text-[var(--blue,#5B9DF0)]",
        label: `${o.side} ${o.symbol} ${o.type}`,
        sublabel: `${o.accountNumber} · ${o.status} · ${o.id}`,
        path: `/manage/accounts/${o.accountId}?highlight=${o.id}`,
      });
    }
    for (const p of results.positions) {
      items.push({
        key: `position-${p.id}`,
        badge: "Position",
        badgeClass: "bg-[var(--warn-bg,rgba(224,168,69,0.12))] text-[var(--warn,#E0A845)]",
        label: `${p.side} ${p.symbol}`,
        sublabel: `${p.accountNumber} · ${p.status} · ${p.id}`,
        path: `/manage/accounts/${p.accountId}?highlight=${p.id}`,
      });
    }
    for (const t of results.transactions) {
      items.push({
        key: `txn-${t.id}`,
        badge: "Txn",
        badgeClass: "bg-[var(--bg-3)] text-[var(--text-2)]",
        label: `${t.type} — ${t.amount}`,
        sublabel: `${t.accountNumber} · ${t.status} · ${t.id}`,
        path: `/manage/accounts/${t.accountId}?highlight=${t.id}`,
      });
    }
    for (const s of results.symbols) {
      items.push({
        key: `symbol-${s.id}`,
        badge: "Symbol",
        badgeClass: "bg-[var(--bg-3)] text-[var(--text-2)]",
        label: s.name,
        sublabel: s.category,
        path: `/manage/symbols?symbol=${encodeURIComponent(s.name)}`,
      });
    }
    return items;
  }, [results]);

  function go(item: FlatItem) {
    saveRecent(query.trim());
    window.location.href = item.path;
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur(); return; }
    if (!open || flat.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => (i + 1) % flat.length); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => (i - 1 + flat.length) % flat.length); return; }
    if (e.key === "Enter") { e.preventDefault(); go(flat[activeIndex] ?? flat[0]); }
  }

  const showRecent = query.trim().length === 0 && recent.length > 0;
  const showDropdown = open && (flat.length > 0 || loading || showRecent || (query.trim().length >= 2 && !loading));

  return (
    <div ref={containerRef} className="relative ml-3 w-72">
      {/* VYX-BASICS-AUDIT.md category 7 "focus states visible" -- the
          <input> below removes its native outline (same reasoning as
          LeverageInput.tsx: the boundary is this wrapper's border, not
          the input's own), but nothing replaced it, so tabbing/clicking
          into search showed no focus indication at all. focus-within
          on the wrapper, same pattern LeverageInput.tsx already uses. */}
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-1.5 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_rgba(30,217,144,0.12)]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--text-3)]">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="w-full bg-transparent text-xs text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
        />
      </div>
      {showDropdown ? (
        <div className="absolute left-0 top-[calc(100%+4px)] z-30 max-h-[420px] w-[420px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-1)] py-1 shadow-lg">
          {showRecent ? (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Recent searches</div>
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[var(--text-2)] hover:bg-[var(--bg-3)]"
                  onClick={() => setQuery(r)}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--text-3)]"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
                  {r}
                </button>
              ))}
            </>
          ) : loading ? (
            <div className="px-3 py-3 text-xs text-[var(--text-3)]">Searching…</div>
          ) : flat.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[var(--text-3)]">No matches for &quot;{query.trim()}&quot;.</div>
          ) : (
            flat.map((item, i) => (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => go(item)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${i === activeIndex ? "bg-[var(--bg-3)]" : ""}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-[var(--text-1)]">{item.label}</span>
                  <span className="block truncate text-[11px] text-[var(--text-3)]">{item.sublabel}</span>
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.badgeClass}`}>{item.badge}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
