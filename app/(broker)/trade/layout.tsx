import type { ReactNode } from "react";
import localFont from "next/font/local";

// WebTrader typography (owner 2026-11-03 design pass): Inter and JetBrains Mono self-hosted by Next (no render-blocking
// Google Fonts request from webtrader.css any more), with the 700 weight the stylesheet uses. They reach webtrader.css as
// --wt-font-sans / --wt-font-mono; display: contents keeps this wrapper out of the terminal's full-height layout.
const wtSans = localFont({ src: "../../fonts/Inter-latin.woff2", weight: "100 900", variable: "--wt-font-sans", display: "swap" });
const wtMono = localFont({ src: "../../fonts/JetBrainsMono-latin.woff2", weight: "100 800", variable: "--wt-font-mono", display: "swap" });
// the share card's referral code (owner 2026-11-14, share-card-prototype.html)
const wtCode = localFont({ src: "../../fonts/Rajdhani-latin.woff2", weight: "700", variable: "--wt-font-code", display: "swap" });

export default function TradeLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${wtSans.variable} ${wtMono.variable} ${wtCode.variable}`} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
