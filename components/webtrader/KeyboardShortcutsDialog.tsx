"use client";

// Menu IA pass -- Tools > Keyboard shortcuts / Help > Shortcuts. Every row
// here is a REAL binding grepped out of this app's own keydown handlers
// (WebTrader.tsx's refresh-shortcut effect, KLineChartPanel.tsx's
// drawing-overlay effect, SmartTradeManager.tsx's hotkey config) -- not a
// generic "what a trading terminal usually has" list. Static content, no
// props needed.
const SHORTCUTS: { keys: string; action: string; note?: string }[] = [
  { keys: "F5", action: "Refresh account data" },
  { keys: "Ctrl/Cmd + R", action: "Refresh account data", note: "same as F5 -- doesn't reload the page" },
  { keys: "Ctrl + 1", action: "Smart Trade Manager: Buy", note: "default binding, reassignable inside Smart Trade Manager" },
  { keys: "Ctrl + 2", action: "Smart Trade Manager: Sell", note: "default binding, reassignable inside Smart Trade Manager" },
  { keys: "Delete / Backspace", action: "Remove the selected chart drawing" },
  { keys: "Escape", action: "Cancel an in-progress drawing tool, or close an open menu/dialog" },
];

export default function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 360 }}>
          <div className="generic-modal-title">Keyboard shortcuts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
            {SHORTCUTS.map((s) => (
              <div key={s.keys + s.action} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontSize: 12.5, color: "var(--text-1)" }}>{s.action}</div>
                  {s.note ? <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 2 }}>{s.note}</div> : null}
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-2)", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 7px", flexShrink: 0, whiteSpace: "nowrap" }}>
                  {s.keys}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
