import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AdminShell, type AdminNavGroup, type AdminNavItem } from "@/components/admin/AdminShell";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { TopbarSearch } from "@/components/admin/TopbarSearch";
import AuditLogTable from "@/app/manage/(shell)/audit/AuditLogTable";
import { apiCall } from "@/lib/desktop-api";
import type { ApiBrokerBranding } from "@/lib/trade-api";

type ShellInfo = {
  brokerName: string;
  brokerLogoUrl: string | null;
  adminEmail: string | null;
  role: "MANAGER" | "BROKER_ADMIN";
  unreadNotifications: number;
};

// The bundled Manager/Broker-Admin desktop terminal's real entry point.
// Unlike the website (real multi-page routing across /manage/*), this is
// a single page with an in-memory "current section" switch -- AdminShell
// takes isActive/renderNavLink as props for exactly this reason (see its
// own doc comment). Section content is added incrementally as each
// Manager component gets its props->fetch inversion (see the bundled-UI
// architecture plan); an unconverted section shows an honest
// "not available yet" placeholder rather than silently rendering nothing.
export default function App() {
  const [branding, setBranding] = useState<ApiBrokerBranding | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [shellInfo, setShellInfo] = useState<ShellInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [section, setSection] = useState("/manage/audit");

  useEffect(() => {
    apiCall<ApiBrokerBranding>("/api/trade/broker-branding")
      .then(setBranding)
      .catch(() => setBranding({ brokerName: "VyXTrader", brokerLogoUrl: "", supportEmail: null }));
  }, []);

  async function loadShellInfo() {
    const info = await apiCall<ShellInfo>("/api/manage/shell-info");
    setShellInfo(info);
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoggingIn(true);
    try {
      await apiCall("/api/manage/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await loadShellInfo();
      setLoggedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setLoggingIn(false);
    }
  }

  if (!loggedIn || !shellInfo) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[#07090C] text-[#e8ecf4]">
        {branding?.brokerLogoUrl ? (
          <img src={branding.brokerLogoUrl} alt={branding.brokerName} className="mb-6 max-h-10" />
        ) : (
          <div className="mb-6 text-lg font-semibold">{branding?.brokerName ?? ""}</div>
        )}
        <form onSubmit={handleLogin} className="flex w-72 flex-col gap-3">
          <input
            placeholder="Email address"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-[#1A222C] bg-[#0E1319] px-3 py-2.5 text-[#e8ecf4] outline-none"
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-[#1A222C] bg-[#0E1319] px-3 py-2.5 text-[#e8ecf4] outline-none"
          />
          {error ? <div className="text-sm text-[#EA3943]">{error}</div> : null}
          <button
            type="submit"
            disabled={loggingIn}
            className="rounded-md bg-[#16C784] px-3 py-2.5 font-semibold text-[#07090C]"
          >
            {loggingIn ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  const isBrokerAdmin = shellInfo.role === "BROKER_ADMIN";

  // Same structure as app/manage/(shell)/layout.tsx's own navGroups --
  // hrefs are just section keys here (no real routes exist), not URLs.
  const navGroups: AdminNavGroup[] = [
    {
      label: "Overview",
      items: [
        { href: "/manage/dashboard", label: "Dashboard" },
        {
          href: "/manage/notifications",
          label: "Notifications",
          ...(shellInfo.unreadNotifications > 0 ? { badge: shellInfo.unreadNotifications } : {}),
        },
      ],
    },
    {
      label: "Clients",
      items: [
        { href: "/manage/accounts", label: "Trading Accounts" },
        { href: "/manage/leads", label: "Leads" },
        ...(isBrokerAdmin ? [{ href: "/manage/kyc", label: "KYC review" }] : []),
      ],
    },
    {
      label: "Trading",
      items: [
        { href: "/manage/positions", label: "Live Exposure" },
        { href: "/manage/dealing", label: "Dealing queue" },
        { href: "/manage/symbols", label: "Symbols" },
        { href: "/manage/groups", label: "Client groups" },
      ],
    },
    {
      label: "Organization",
      items: [
        { href: "/manage/reports", label: "Reports" },
        { href: "/manage/audit", label: "Audit log" },
      ],
    },
  ];

  const isActive = (href: string) => href === section;
  const renderNavLink = (item: AdminNavItem, children: ReactNode, className: string) => (
    <button type="button" onClick={() => setSection(item.href)} className={`${className} w-full text-left`}>
      {children}
    </button>
  );

  return (
    <AdminShell
      title={shellInfo.brokerName}
      logoUrl={shellInfo.brokerLogoUrl}
      pageTitle="Backoffice"
      navGroups={navGroups}
      isActive={isActive}
      renderNavLink={renderNavLink}
      topbarSearch={<TopbarSearch placeholder="Search clients, transactions…" />}
      topbarRight={
        <div className="flex items-center gap-2">
          <div className="flex flex-col leading-tight">
            <span className="text-xs font-semibold text-[var(--text-1)]">{shellInfo.adminEmail}</span>
            <span className="text-[10px] text-[var(--text-3)]">{isBrokerAdmin ? "Broker Admin" : "Manager"}</span>
          </div>
          <LogoutButton loginHref="/manage/login" onLoggedOut={() => setLoggedIn(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </LogoutButton>
        </div>
      }
    >
      {section === "/manage/audit" ? (
        <AuditLogTable />
      ) : (
        <p className="text-sm text-[var(--text-3)]">This section isn't available in the desktop app yet.</p>
      )}
    </AdminShell>
  );
}
