import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Rajdhani } from "next/font/google";

// WebTrader typography (owner 2026-11-03 design pass): Inter and JetBrains Mono self-hosted by Next (no render-blocking
// Google Fonts request from webtrader.css any more), with the 700 weight the stylesheet uses. They reach webtrader.css as
// --wt-font-sans / --wt-font-mono; display: contents keeps this wrapper out of the terminal's full-height layout.
const wtSans = Inter({ variable: "--wt-font-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
const wtMono = JetBrains_Mono({ variable: "--wt-font-mono", subsets: ["latin"], weight: ["400", "500", "600", "700"], display: "swap" });
// the share card's referral code (owner 2026-11-14, share-card-prototype.html)
const wtCode = Rajdhani({ variable: "--wt-font-code", subsets: ["latin"], weight: ["700"], display: "swap" });

export default function TradeLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${wtSans.variable} ${wtMono.variable} ${wtCode.variable}`} style={{ display: "contents" }}>
      {children}
    </div>
  );
}
