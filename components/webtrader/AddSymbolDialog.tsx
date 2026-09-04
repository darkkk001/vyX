"use client";

import { useMemo, useState } from "react";
import {
  fmt,
  SYMBOL_CATEGORY_LABELS as CATEGORY_LABELS,
  SYMBOL_CATEGORY_ORDER as CATEGORY_ORDER,
  type MarketState,
  type SymbolCategory,
  type SymbolDef,
} from "@/lib/market-simulator";

export default function AddSymbolDialog({
  allSymbols,
  market,
  watchlistNames,
  onAdd,
  onClose,
}: {
  allSymbols: SymbolDef[];
  market: Record<string, MarketState>;
  watchlistNames: string[];
  onAdd: (name: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");

  const grouped = useMemo(() => {
    const bySearch = allSymbols.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
    const groups = new Map<SymbolCategory, SymbolDef[]>();
    for (const s of bySearch) {
      const list = groups.get(s.category) ?? [];
      list.push(s);
      groups.set(s.category, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => ({ category: c, symbols: groups.get(c)! }));
  }, [allSymbols, search]);

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" aria-label="Close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 380 }}>
          <div className="generic-modal-title">Add symbol</div>
          <input
            className="generic-modal-input mono"
            autoFocus
            placeholder="Search symbol…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ maxHeight: 360, overflowY: "auto", marginTop: 10 }}>
            {grouped.length === 0 ? (
              <div style={{ padding: "16px 4px", fontSize: 12, color: "var(--text-3)", textAlign: "center" }}>No symbols match.</div>
            ) : (
              grouped.map(({ category, symbols }) => (
                <div key={category} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-3)", padding: "4px 2px" }}>
                    {CATEGORY_LABELS[category]}
                  </div>
                  {symbols.map((s) => {
                    const row = market[s.name];
                    const already = watchlistNames.includes(s.name);
                    return (
                      <div
                        key={s.name}
                        className="acc-option"
                        style={{ cursor: already ? "default" : "pointer", padding: "7px 8px", display: "flex", alignItems: "center", justifyContent: "space-between", opacity: already ? 0.55 : 1 }}
                        onClick={() => { if (!already) onAdd(s.name); }}
                      >
                        <span className="mono">{s.name}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {row?.live ? (
                            <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                              {fmt(row.bid, s.digits)} / {fmt(row.ask, s.digits)}
                            </span>
                          ) : (
                            <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>-</span>
                          )}
                          {already ? (
                            <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>Added</span>
                          ) : (
                            <span className="wl-add-inline-btn" title="Add to watchlist">+</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
