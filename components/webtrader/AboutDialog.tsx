"use client";

// Menu IA pass -- Help > About, upgraded from a plain pushToast() to a
// real panel. Deliberately doesn't show a version number: this web
// bundle has no NEXT_PUBLIC_APP_VERSION or equivalent exposed to the
// client, and the bundled desktop shell's own Tauri version isn't
// surfaced through window.vyxDesktop either -- inventing one would be
// worse than omitting it.
export default function AboutDialog({
  brokerName,
  brokerLogoUrl,
  isDesktopApp,
  onClose,
}: {
  brokerName: string;
  brokerLogoUrl: string;
  isDesktopApp: boolean;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-wrap">
        <button className="modal-close" aria-label="Close" onClick={onClose}>✕</button>
        <div className="generic-modal-card" style={{ width: 300, textAlign: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "8px 0 4px" }}>
            <span style={{ width: 44, height: 44, borderRadius: 10, background: "var(--bg-3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, overflow: "hidden" }}>
              {brokerLogoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brokerLogoUrl} alt={brokerName} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                brokerName.charAt(0).toUpperCase()
              )}
            </span>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-1)" }}>{brokerName} Trader Terminal</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{isDesktopApp ? "Desktop app" : "Web terminal"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
