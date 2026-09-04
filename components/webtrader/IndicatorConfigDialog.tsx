"use client";

import { useState } from "react";
import { INDICATOR_DEFS, type ActiveIndicator } from "@/lib/chart-indicators";

// Chart indicators feature -- small per-indicator config dialog. Live
// preview: every valid edit calls onChange immediately (WebTrader.tsx's
// own handler updates the `activeIndicators` array, which flows straight
// down into KLineChartPanel's reconcile effect and calls
// klinecharts' overrideIndicator right away) rather than waiting for an
// explicit Save -- matches the spec's own "editable, live preview"
// requirement. Persisting the final values server-side is debounced
// separately by the caller (same chained-save pattern chartSettings
// already uses), not this dialog's concern.
const MULTI_PERIOD_KEYS = new Set(["MA", "EMA", "RSI", "WR"]);

export default function IndicatorConfigDialog({
  indicator,
  onChange,
  onRemove,
  onClose,
}: {
  indicator: ActiveIndicator;
  onChange: (calcParams: number[]) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const def = INDICATOR_DEFS[indicator.key];
  const [draft, setDraft] = useState<number[]>(indicator.calcParams);
  const multiPeriod = MULTI_PERIOD_KEYS.has(indicator.key);

  function commit(next: number[]) {
    setDraft(next);
    if (next.length > 0 && next.every((n) => Number.isFinite(n) && n > 0)) onChange(next);
  }

  function setParam(i: number, raw: string) {
    const value = parseFloat(raw);
    const next = draft.slice();
    next[i] = value;
    commit(next);
  }

  function addPeriod() {
    commit([...draft, draft[draft.length - 1] ?? 14]);
  }

  function removePeriod(i: number) {
    if (draft.length <= 1) return;
    commit(draft.filter((_, idx) => idx !== i));
  }

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" aria-label="Close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 280 }}>
          <div className="generic-modal-title">{def.label}</div>

          {draft.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--text-3)", margin: "8px 0 4px" }}>
              No parameters, session-cumulative from the start of each day (UTC).
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {draft.map((value, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span className="field-label">{def.paramLabels[i] ?? `Period ${i + 1}`}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="number"
                      className="mono"
                      value={Number.isFinite(value) ? value : ""}
                      min={indicator.key === "BOLL" && i === 1 ? 0.1 : 1}
                      step={indicator.key === "BOLL" && i === 1 ? 0.1 : 1}
                      onChange={(e) => setParam(i, e.target.value)}
                      style={{
                        width: 64,
                        background: "var(--bg-2)",
                        border: "1px solid var(--border)",
                        borderRadius: 5,
                        color: "var(--text-1)",
                        padding: "4px 6px",
                        fontSize: 12,
                      }}
                    />
                    {multiPeriod && draft.length > 1 ? (
                      <button
                        onClick={() => removePeriod(i)}
                        title="Remove period"
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          border: "none",
                          background: "transparent",
                          color: "var(--text-3)",
                          cursor: "pointer",
                          fontSize: 11,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {multiPeriod ? (
            <button
              onClick={addPeriod}
              style={{
                width: "100%",
                marginTop: 10,
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px dashed var(--border-strong)",
                background: "transparent",
                color: "var(--text-2)",
                fontSize: 11.5,
                cursor: "pointer",
              }}
            >
              + Add period
            </button>
          ) : null}

          <button
            className="confirm-market-btn sell"
            style={{ display: "block", width: "100%", marginTop: 16 }}
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            Remove indicator
          </button>
        </div>
      </div>
    </div>
  );
}
