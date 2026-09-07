"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import styles from "./PortalShell.module.css";

const NAV_ITEMS: { href: string; label: string; icon: React.ReactNode }[] = [
  {
    href: "/portal",
    label: "Dashboard",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>,
  },
  {
    href: "/portal/accounts",
    label: "Trading Accounts",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>,
  },
  {
    href: "/portal/funds",
    label: "Deposits & Withdrawals",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>,
  },
  {
    href: "/portal/kyc",
    label: "KYC",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="10" /></svg>,
  },
  {
    href: "/portal/profile",
    label: "Profile",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 4-6 8-6s8 2 8 6" /></svg>,
  },
  {
    href: "/portal/webtrader",
    label: "WebTrader",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18" /><path d="M18.5 8 13 13.5l-3-3L5 16" /></svg>,
  },
];

export default function PortalSidebar({
  brokerName,
  brokerLogoUrl,
  clientFullName,
  clientEmail,
}: {
  brokerName: string;
  brokerLogoUrl: string | null;
  clientFullName: string;
  clientEmail: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/portal/logout", { method: "POST" });
    router.push("/portal/login");
    router.refresh();
  }

  const initials = clientFullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        {brokerLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brokerLogoUrl} alt={`${brokerName} logo`} className={styles.logo} />
        ) : null}
        <span className={styles.brandName}>{brokerName}</span>
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          // Exact match for /portal itself (else it'd stay "active" on
          // every sub-route too, since every one of them starts with the
          // same prefix); startsWith for every other tab's own subtree.
          const active = item.href === "/portal" ? pathname === "/portal" : pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}>
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className={styles.sidebarFoot}>
        <div className={styles.clientRow}>
          <div className={styles.clientAvatar}>{initials}</div>
          <div className={styles.clientInfo}>
            <span className={styles.clientName}>{clientFullName}</span>
            <span className={styles.clientEmail}>{clientEmail}</span>
          </div>
        </div>
        <button type="button" className={styles.logoutBtn} onClick={handleLogout}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
          Log out
        </button>
      </div>
    </aside>
  );
}
