"use client";

import { useState } from "react";
import type { ChartSettings } from "@/lib/chart-settings";

type Tab = "profile" | "trading" | "appearance" | "notifications";

const SOUND_FIELDS: { key: keyof ChartSettings; label: string }[] = [
  { key: "soundOrderFilled", label: "Order filled" },
  { key: "soundPositionClosed", label: "Position closed" },
  { key: "soundSlHit", label: "Stop loss hit" },
  { key: "soundTpHit", label: "Take profit hit" },
  { key: "soundPendingTriggered", label: "Pending order triggered" },
  { key: "soundRequoteReceived", label: "Requote received" },
  { key: "soundAlertTriggered", label: "Price alert triggered" },
  { key: "soundError", label: "Order error / reject" },
];

// Menu IA pass -- replaces the rail gear icon's old "opens Change
// Password directly" behavior. Every row here delegates to something
// that already exists (the three Profile actions open their own
// existing modals; Appearance's theme/palette controls are the same
// changeColorMode/changeTheme WebTrader.tsx already had) -- this dialog
// is an index into those, not a reimplementation of any of them, except
// where noted (Reset layout, and the sound toggles duplicated here from
// ChartSettingsDialog for a real "Notifications" destination that
// doesn't require leaving Settings).
export default function SettingsDialog({
  chartSettings,
  colorMode,
  onChangeColorMode,
  theme,
  onChangeTheme,
  onToggleSetting,
  twoFactorEnabled,
  onOpenChangePassword,
  onOpenSecurity,
  onOpenKyc,
  onOpenAlertsManager,
  onResetLayout,
  onClose,
}: {
  chartSettings: ChartSettings;
  colorMode: "dark" | "light";
  onChangeColorMode: (mode: "dark" | "light") => void;
  theme: "default" | "classic";
  onChangeTheme: (theme: "default" | "classic") => void;
  onToggleSetting: (key: keyof ChartSettings) => void;
  twoFactorEnabled: boolean;
  onOpenChangePassword: () => void;
  onOpenSecurity: () => void;
  onOpenKyc: () => void;
  onOpenAlertsManager: () => void;
  onResetLayout: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");

  const TABS: { id: Tab; label: string }[] = [
    { id: "profile", label: "Profile" },
    { id: "trading", label: "Trading" },
    { id: "appearance", label: "Appearance" },
    { id: "notifications", label: "Notifications" },
  ];

  function row(action: () => void, label: string, hint?: string) {
    return (
      <div
        className="acc-option"
        style={{ cursor: "pointer", padding: "10px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        onClick={action}
      >
        <span style={{ fontSize: 13 }}>{label}</span>
        {hint ? <span style={{ fontSize: 11, color: "var(--text-3)" }}>{hint}</span> : <span style={{ color: "var(--text-3)" }}>›</span>}
      </div>
    );
  }

  function toggleRow(key: keyof ChartSettings, label: string) {
    return (
      <div key={key} className="occ-toggle-row">
        <span className="field-label">{label}</span>
        <label className="switch">
          <input type="checkbox" checked={chartSettings[key] as boolean} onChange={() => onToggleSetting(key)} />
          <span className="switch-slider" />
        </label>
      </div>
    );
  }

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 360 }}>
          <div className="generic-modal-title">Settings</div>

          <div className="order-type-tabs" style={{ marginTop: 10, marginBottom: 4 }}>
            {TABS.map((t) => (
              <button key={t.id} className={`ot-tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "profile" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {row(onOpenChangePassword, "Change password")}
              {row(onOpenSecurity, "Two-factor authentication", twoFactorEnabled ? "On" : "Off")}
              {row(onOpenKyc, "Verify identity")}
            </div>
          ) : null}

          {tab === "trading" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div className="occ-toggle-row">
                <span className="field-label">One-click trading (default)</span>
                <label className="switch">
                  <input type="checkbox" checked={chartSettings.oneClickDefault} onChange={() => onToggleSetting("oneClickDefault")} />
                  <span className="switch-slider" />
                </label>
              </div>
              <p className="net-pos-detail" style={{ marginTop: 6 }}>
                Same switch as the order ticket&apos;s own one-click toggle -- persists across logins either way.
              </p>
            </div>
          ) : null}

          {tab === "appearance" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div className="occ-toggle-row">
                <span className="field-label">Dark mode</span>
                <label className="switch">
                  <input type="checkbox" checked={colorMode === "dark"} onChange={(e) => onChangeColorMode(e.target.checked ? "dark" : "light")} />
                  <span className="switch-slider" />
                </label>
              </div>
              <div style={{ padding: "10px 0 2px", fontSize: 10, color: "var(--text-3)", textTransform: "uppercase" }}>Palette</div>
              <div className="occ-toggle-row" style={{ cursor: "pointer" }} onClick={() => onChangeTheme("default")}>
                <span className="field-label">Default</span>
                {theme === "default" ? <span style={{ color: "var(--buy)" }}>✓</span> : null}
              </div>
              <div className="occ-toggle-row" style={{ cursor: "pointer" }} onClick={() => onChangeTheme("classic")}>
                <span className="field-label">Classic</span>
                {theme === "classic" ? <span style={{ color: "var(--buy)" }}>✓</span> : null}
              </div>
              <button
                className="confirm-market-btn"
                style={{ display: "block", width: "100%", marginTop: 14, background: "var(--bg-3)", color: "var(--text-1)" }}
                onClick={onResetLayout}
              >
                Reset layout to default
              </button>
            </div>
          ) : null}

          {tab === "notifications" ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {row(onOpenAlertsManager, "Manage price alerts")}
              <div style={{ height: 1, background: "var(--border)", margin: "6px 0 8px" }} />
              <div className="occ-toggle-row">
                <span className="field-label">Sounds</span>
                <label className="switch">
                  <input type="checkbox" checked={chartSettings.soundsEnabled} onChange={() => onToggleSetting("soundsEnabled")} />
                  <span className="switch-slider" />
                </label>
              </div>
              <div style={{ opacity: chartSettings.soundsEnabled ? 1 : 0.4, pointerEvents: chartSettings.soundsEnabled ? "auto" : "none" }}>
                {SOUND_FIELDS.map((f) => toggleRow(f.key, f.label))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
