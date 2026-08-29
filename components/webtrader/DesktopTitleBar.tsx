"use client";

import { useEffect, useState } from "react";

// Renders only inside the Tauri desktop shell (frameless window, no
// native title bar of its own — see desktop-tauri/src-tauri/src/main.rs's
// `.decorations(false)`). Nothing renders in a normal browser tab, where
// the OS/browser chrome already provides this.
//
// "Glass elevated" style -- a floating frosted bar instead of a flat
// strip, replacing the old bare connection signal-bars with a real
// Live/Demo status pill so the trader's account mode is visible without
// opening the account switcher. This is also now the ONLY place broker
// identity (logo + name) shows in desktop builds -- WebTrader.tsx's own
// topbar hides its own centered broker-logo block when running desktop
// (see its own isDesktopApp check) specifically to avoid the two bars
// both showing "Futurix Global" at once.
export default function DesktopTitleBar({
  brokerName,
  brokerLogoUrl,
  server,
  connected,
}: {
  brokerName: string;
  brokerLogoUrl?: string | null;
  server: string;
  connected: boolean;
}) {
  const [isDesktop, setIsDesktop] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!window.vyxDesktop?.isDesktop) return;
    setIsDesktop(true);
    return window.vyxDesktop.onMaximizedChange?.(setMaximized);
  }, []);

  if (!isDesktop) return null;

  // server arrives as "BrokerName-Live"/"BrokerName-Demo" (WebTrader.tsx's
  // own serverName) or "" pre-login -- pull just the mode back out rather
  // than adding a whole separate prop for it.
  const mode = server.endsWith("-Live") ? "LIVE" : server.endsWith("-Demo") ? "DEMO" : null;

  return (
    <div
      style={{
        // @ts-expect-error -- WebkitAppRegion isn't in the CSSProperties typings
        WebkitAppRegion: "drag",
        background:
          "radial-gradient(circle at 15% -40%, rgba(244, 85, 28, 0.16), transparent 55%), #07090C",
        padding: "8px 8px 0",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 44,
          padding: "0 8px 0 12px",
          gap: 10,
          borderRadius: 10,
          background: "rgba(19, 26, 34, 0.55)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
          border: "1px solid rgba(255, 255, 255, 0.07)",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 12px 32px -12px rgba(0, 0, 0, 0.5)",
        }}
      >
        {brokerLogoUrl ? (
          <img src={brokerLogoUrl} alt="" style={{ width: 22, height: 22, borderRadius: 6, objectFit: "cover", flexShrink: 0 }} />
        ) : (
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: "linear-gradient(155deg, #ff7a42, #f4551c)",
              boxShadow: "0 0 0 1px rgba(255,255,255,.12) inset",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 800,
              color: "#07090C",
              flexShrink: 0,
            }}
          >
            {brokerName.charAt(0).toUpperCase() || "V"}
          </span>
        )}
        <span style={{ fontSize: 13, color: "#edeff2", fontWeight: 650 }}>{brokerName}</span>

        <div style={{ flex: 1 }} />

        {mode ? (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              fontWeight: 600,
              color: mode === "LIVE" ? "#16C784" : "#8B93A1",
              background: mode === "LIVE" ? "rgba(22, 199, 132, 0.1)" : "rgba(139, 147, 161, 0.1)",
              border: `1px solid ${mode === "LIVE" ? "rgba(22, 199, 132, 0.25)" : "rgba(139, 147, 161, 0.22)"}`,
              padding: "5px 11px",
              borderRadius: 999,
              marginRight: 8,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: connected ? (mode === "LIVE" ? "#16C784" : "#8B93A1") : "#EA3943",
                boxShadow: connected ? `0 0 8px ${mode === "LIVE" ? "rgba(22,199,132,.4)" : "rgba(139,147,161,.3)"}` : "none",
              }}
            />
            {mode === "LIVE" ? "Live" : "Demo"}
          </span>
        ) : (
          <span title={connected ? "Connected" : "Disconnected"} style={{ display: "flex", alignItems: "center", marginRight: 8 }}>
            <SignalBars connected={connected} />
          </span>
        )}

        <div
          // @ts-expect-error -- WebkitAppRegion isn't in the CSSProperties typings
          style={{ WebkitAppRegion: "no-drag", display: "flex", height: "100%" }}
        >
          <TitleBarButton onClick={() => window.vyxDesktop?.minimize?.()} label="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
          </TitleBarButton>
          <TitleBarButton onClick={() => window.vyxDesktop?.toggleMaximize?.()} label={maximized ? "Restore" : "Maximize"}>
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
                <rect x="0" y="2" width="8" height="8" fill="#131a22" stroke="currentColor" strokeWidth="1" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            )}
          </TitleBarButton>
          <TitleBarButton onClick={() => window.vyxDesktop?.close?.()} label="Close" danger>
            <svg width="10" height="10" viewBox="0 0 10 10">
              <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.1" />
              <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </TitleBarButton>
        </div>
      </div>
    </div>
  );
}

function SignalBars({ connected }: { connected: boolean }) {
  const active = "#16C784";
  const dim = "#EA3943";
  const off = "#2a303c";
  const bars = [
    { h: 4, y: 8 },
    { h: 6.5, y: 5.5 },
    { h: 9, y: 3 },
    { h: 12, y: 0 },
  ];
  return (
    <svg width="15" height="12" viewBox="0 0 15 12">
      {bars.map((b, i) => (
        <rect
          key={i}
          x={i * 3.9}
          y={b.y}
          width="2.6"
          height={b.h}
          rx="0.6"
          fill={connected ? active : i === 0 ? dim : off}
        />
      ))}
    </svg>
  );
}

function TitleBarButton({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      aria-label={label}
      style={{
        width: 40,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        background: hover ? (danger ? "#EA3943" : "rgba(255,255,255,0.08)") : "transparent",
        color: hover && danger ? "#fff" : "#8891a6",
        border: "none",
        cursor: "pointer",
        transition: "background .12s, color .12s",
      }}
    >
      {children}
    </button>
  );
}
