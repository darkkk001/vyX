"use client";

import { useEffect, useState } from "react";

// Renders only inside the Electron shell (frame:false — see desktop/main.js
// — has no native title bar of its own). Nothing renders in a normal
// browser tab, where the OS/browser chrome already provides this.
export default function DesktopTitleBar({
  brokerName,
  server,
  connected,
}: {
  brokerName: string;
  server: string;
  connected: boolean;
}) {
  const [isDesktop, setIsDesktop] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!window.vyxDesktop?.isDesktop) return;
    setIsDesktop(true);
    return window.vyxDesktop.onMaximizedChange(setMaximized);
  }, []);

  if (!isDesktop) return null;

  return (
    <div
      // @ts-expect-error -- WebkitAppRegion isn't in the CSSProperties typings
      style={{ WebkitAppRegion: "drag", display: "flex", alignItems: "center", height: 32, background: "#0b0e14", borderBottom: "1px solid #1b2130", flexShrink: 0, padding: "0 10px", gap: 8 }}
    >
      <span style={{ width: 16, height: 16, borderRadius: 4, background: "#16C784", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: "#07090C", flexShrink: 0 }}>
        X
      </span>
      <span style={{ fontSize: 12, color: "#c7cdda", fontWeight: 500 }}>
        {brokerName}
        {server ? <span style={{ color: "#5A6472" }}> — {server}</span> : null}
      </span>

      <div style={{ flex: 1 }} />

      <span title={connected ? "Connected" : "Disconnected"} style={{ display: "flex", alignItems: "center", marginRight: 8 }}>
        <SignalBars connected={connected} />
      </span>

      <div
        // @ts-expect-error -- WebkitAppRegion isn't in the CSSProperties typings
        style={{ WebkitAppRegion: "no-drag", display: "flex", height: "100%" }}
      >
        <TitleBarButton onClick={() => window.vyxDesktop?.minimize()} label="Minimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
        </TitleBarButton>
        <TitleBarButton onClick={() => window.vyxDesktop?.toggleMaximize()} label={maximized ? "Restore" : "Maximize"}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2" y="0" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="0" y="2" width="8" height="8" fill="#0b0e14" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="0" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </TitleBarButton>
        <TitleBarButton onClick={() => window.vyxDesktop?.close()} label="Close" danger>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.1" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </TitleBarButton>
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
        width: 44,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover ? (danger ? "#EA3943" : "#1b2130") : "transparent",
        color: hover && danger ? "#fff" : "#8891a6",
        border: "none",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
