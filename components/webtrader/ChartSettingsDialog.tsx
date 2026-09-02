"use client";

import { useState } from "react";
import type { ChartSettings } from "@/lib/chart-settings";

// chart interaction pack §2 -- candle colors, grid/last-price-line/
// session-high-low/OHLC-bar visibility, timezone (UTC only for now,
// groundwork for a real selector later). Edits a local draft and only
// calls onSave once, on the explicit Save click -- same "don't mutate the
// server on every keystroke" shape as the rest of this app's modals
// (AddSymbolDialog aside, which has no fields to debounce in the first
// place).
export default function ChartSettingsDialog({
  settings,
  onSave,
  onClose,
}: {
  settings: ChartSettings;
  onSave: (next: ChartSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ChartSettings>(settings);

  function set<K extends keyof ChartSettings>(key: K, value: ChartSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const colorFields: { key: keyof ChartSettings; label: string }[] = [
    { key: "candleUpColor", label: "Up body" },
    { key: "candleDownColor", label: "Down body" },
    { key: "candleUpBorderColor", label: "Up border" },
    { key: "candleDownBorderColor", label: "Down border" },
    { key: "candleUpWickColor", label: "Up wick" },
    { key: "candleDownWickColor", label: "Down wick" },
  ];

  const toggleFields: { key: keyof ChartSettings; label: string }[] = [
    { key: "showGrid", label: "Grid lines" },
    { key: "showLastPriceLine", label: "Last-price line" },
    { key: "showSessionHighLow", label: "Previous day high/low (PDH/PDL)" },
    { key: "showSessionMap", label: "Session map (Asia/London/NY)" },
    { key: "showOhlcBar", label: "OHLC info bar" },
  ];

  const soundFields: { key: keyof ChartSettings; label: string }[] = [
    { key: "soundOrderFilled", label: "Order filled" },
    { key: "soundPositionClosed", label: "Position closed" },
    { key: "soundSlHit", label: "Stop loss hit" },
    { key: "soundTpHit", label: "Take profit hit" },
    { key: "soundPendingTriggered", label: "Pending order triggered" },
    { key: "soundRequoteReceived", label: "Requote received" },
    { key: "soundAlertTriggered", label: "Price alert triggered" },
    { key: "soundError", label: "Order error / reject" },
  ];

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 340 }}>
          <div className="generic-modal-title">Chart settings</div>

          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-3)", margin: "12px 0 6px" }}>Candles</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {colorFields.map((f) => (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span className="field-label">{f.label}</span>
                <input
                  type="color"
                  value={draft[f.key] as string}
                  onChange={(e) => set(f.key, e.target.value as ChartSettings[typeof f.key])}
                  style={{ width: 28, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 3, background: "none", cursor: "pointer" }}
                />
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-3)", margin: "14px 0 6px" }}>Display</div>
          {toggleFields.map((f) => (
            <div key={f.key} className="occ-toggle-row">
              <span className="field-label">{f.label}</span>
              <label className="switch">
                <input type="checkbox" checked={draft[f.key] as boolean} onChange={(e) => set(f.key, e.target.checked as ChartSettings[typeof f.key])} />
                <span className="switch-slider" />
              </label>
            </div>
          ))}

          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-3)", margin: "14px 0 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Sounds</span>
            <label className="switch">
              <input type="checkbox" checked={draft.soundsEnabled} onChange={(e) => set("soundsEnabled", e.target.checked)} />
              <span className="switch-slider" />
            </label>
          </div>
          <div style={{ opacity: draft.soundsEnabled ? 1 : 0.4, pointerEvents: draft.soundsEnabled ? "auto" : "none" }}>
            {soundFields.map((f) => (
              <div key={f.key} className="occ-toggle-row">
                <span className="field-label">{f.label}</span>
                <label className="switch">
                  <input type="checkbox" checked={draft[f.key] as boolean} onChange={(e) => set(f.key, e.target.checked as ChartSettings[typeof f.key])} />
                  <span className="switch-slider" />
                </label>
              </div>
            ))}
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <span className="field-label">Timezone</span>
            {/* Only UTC exists today -- see ChartSettings.timezone's own
                comment. A disabled select (not a static label) so a real
                selector can be dropped in later without touching this
                dialog's layout. */}
            <select className="mono" value={draft.timezone} disabled style={{ opacity: 0.6 }}>
              <option value="UTC">UTC</option>
            </select>
          </div>

          <button className="confirm-market-btn buy" style={{ display: "block", width: "100%", marginTop: 16 }} onClick={() => { onSave(draft); onClose(); }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
