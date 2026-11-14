import { cookies } from "next/headers";
import type { ReactNode, CSSProperties } from "react";
import localFont from "next/font/local";
import type { RoomBroker } from "@/lib/room/context";
import "@/app/(broker)/room/room.css";
import DevToolsGuard from "@/components/security/DevToolsGuard";

// The Trader's Room root: fonts, theme and tenant accent. Wraps /room/* (room/layout.tsx) and the room's sign-in and
// sign-up, which live at /login and /register (owner routes 2026-11-04), outside that layout.
// Theme: dark by default, light from the room_theme cookie (no flash).
const inter = localFont({ src: "../../app/fonts/Inter-latin.woff2", weight: "100 900", variable: "--r-font-inter", display: "swap" });
const mono = localFont({ src: "../../app/fonts/JetBrainsMono-latin.woff2", weight: "100 800", variable: "--r-font-mono", display: "swap" });
const grotesk = localFont({ src: "../../app/fonts/SpaceGrotesk-latin.woff2", weight: "300 700", variable: "--r-font-grotesk", display: "swap" });

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Text on the tenant's accent: near-black on a light accent, white on a dark one (WCAG relative luminance). */
function onAccent(hex: string): string {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return l > 0.3 ? "#141413" : "#FFFFFF";
}

export default async function RoomFrame({ broker, children }: { broker: RoomBroker; children: ReactNode }) {
  const theme = (await cookies()).get("room_theme")?.value === "light" ? "light" : "dark";
  const style = broker.primaryColor && HEX.test(broker.primaryColor)
    ? ({ "--r-accent": broker.primaryColor, "--r-on-accent": onAccent(broker.primaryColor) } as CSSProperties)
    : undefined;
  return (
    <div className={`room ${inter.variable} ${mono.variable} ${grotesk.variable}`} data-theme={theme} style={style}>
      <DevToolsGuard />
      {children}
    </div>
  );
}
