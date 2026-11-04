"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import RoomBrand from "./RoomBrand";
import { useRoom } from "./RoomData";
import { initials } from "./format";

// Trader's Room sidebar, as on every artboard: OVERVIEW / FUNDS / PERFORMANCE / PARTNER / MORE, KYC state and the
// client at the foot. PARTNER shows only for a client the broker has flagged as an IB.
const I = (d: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{d}</svg>
);
const ICONS: Record<string, ReactNode> = {
  dashboard: I(<><rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" /><rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" /></>),
  accounts: I(<><rect x="2" y="4" width="12" height="9" rx="1.5" /><path d="M2 7.5h12" /></>),
  deposit: I(<><rect x="2" y="7" width="12" height="7" rx="1.5" /><path d="M8 1v5M6 4.5 8 6.5l2-2" /></>),
  withdraw: I(<><rect x="2" y="2" width="12" height="7" rx="1.5" /><path d="M8 15v-5M6 11.5 8 9.5l2 2" /></>),
  transfer: I(<path d="M3 5h8M9 2l3 3-3 3M13 11H5M7 8l-3 3 3 3" />),
  history: I(<><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 2" /></>),
  analytics: I(<path d="M2.5 13.5h11M4.5 13.5V8.5M8 13.5V3.5M11.5 13.5V6.5" />),
  journal: I(<><path d="M4 2h8.5v12H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 2Z" /><path d="M2.5 11.5A1.5 1.5 0 0 1 4 10h8.5M6.5 5h3.5" /></>),
  tier: I(<><circle cx="8" cy="5.8" r="3.3" /><path d="m5.8 8.6-1.3 4.4L8 11.6l3.5 1.4-1.3-4.4" /></>),
  partner: I(<><circle cx="6" cy="6" r="2.5" /><path d="M2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4" /><circle cx="11.5" cy="5" r="2" /><path d="M11.5 9.5c1.7.5 2.8 2 2.8 4" /></>),
  downloads: I(<path d="M8 2v8M5 7l3 3 3-3M3 13.5h10" />),
  support: I(<><circle cx="8" cy="8" r="6" /><path d="M6.2 6.1a2 2 0 0 1 3.6 1c0 1.2-1.8 1.4-1.8 2.4" /><circle cx="8" cy="11.7" r="0.6" fill="currentColor" stroke="none" /></>),
  profile: I(<><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" /></>),
};

type Item = { href: string; label: string; icon: string };
const GROUPS: { title: string; items: Item[]; partner?: boolean }[] = [
  { title: "Overview", items: [{ href: "/room", label: "Dashboard", icon: "dashboard" }, { href: "/room/accounts", label: "Accounts", icon: "accounts" }] },
  { title: "Funds", items: [{ href: "/room/deposit", label: "Deposit", icon: "deposit" }, { href: "/room/withdraw", label: "Withdraw", icon: "withdraw" }, { href: "/room/transfer", label: "Transfer", icon: "transfer" }, { href: "/room/history", label: "History", icon: "history" }] },
  { title: "Performance", items: [{ href: "/room/analytics", label: "Analytics", icon: "analytics" }, { href: "/room/journal", label: "Journal", icon: "journal" }, { href: "/room/tier", label: "My Tier", icon: "tier" }] },
  { title: "Partner", partner: true, items: [{ href: "/room/partner", label: "IB Portal", icon: "partner" }] },
  { title: "More", items: [{ href: "/room/downloads", label: "Downloads", icon: "downloads" }, { href: "/room/support", label: "Support", icon: "support" }, { href: "/room/profile", label: "Profile", icon: "profile" }] },
];

const KYC_LINE: Record<string, { text: string; cls: string }> = {
  APPROVED: { text: "KYC VERIFIED", cls: "r-chip-ok" },
  PENDING: { text: "KYC PENDING", cls: "r-chip-pending" },
  REJECTED: { text: "KYC REJECTED", cls: "r-chip-bad" },
  NONE: { text: "KYC NOT VERIFIED", cls: "r-chip-off" },
};

export default function RoomSidebar({ brokerName, logoUrl, isPartner }: { brokerName: string; logoUrl: string | null; isPartner: boolean }) {
  const path = usePathname() ?? "/room";
  const { data } = useRoom();
  const kyc = KYC_LINE[data?.kyc.status ?? "NONE"] ?? KYC_LINE.NONE;
  return (
    <aside className="r-side">
      <a className="r-brand" href="/room"><RoomBrand name={brokerName} logoUrl={logoUrl} /></a>
      {GROUPS.filter((g) => !g.partner || isPartner).map((g) => (
        <div key={g.title} style={{ display: "contents" }}>
          <div className="r-nav-group">{g.title.toUpperCase()}</div>
          {g.items.map((it) => {
            const active = it.href === "/room" ? path === "/room" : path === it.href || path.startsWith(`${it.href}/`);
            return (
              <a key={it.href} href={it.href} className="r-nav" aria-current={active ? "page" : undefined}>
                {ICONS[it.icon]}{it.label}
              </a>
            );
          })}
        </div>
      ))}
      <div className="r-side-foot">
        {data ? <div className={`r-kyc ${kyc.cls}`}><span className="r-dot" />{kyc.text}</div> : null}
        {data ? (
          <div className="r-me">
            <span className="r-avatar">{initials(data.client.fullName)}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{data.client.fullName}</div>
              <div style={{ fontSize: 11, color: "var(--r-muted)" }}>Client · {data.client.clientId}</div>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
