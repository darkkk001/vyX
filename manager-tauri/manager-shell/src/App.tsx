import { useEffect, useState, type ReactNode } from "react";
import ManagerLoginForm from "@/app/manage/login/ManagerLoginForm";
import { AdminShell, type AdminNavGroup, type AdminNavItem } from "@/components/admin/AdminShell";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { TopbarSearch } from "@/components/admin/TopbarSearch";
import { PageHeader } from "@/components/ui/PageHeader";
import AuditLogTable from "@/app/manage/(shell)/audit/AuditLogTable";
import SecurityManager from "@/components/admin/SecurityManager";
import DashboardManager from "@/app/manage/(shell)/dashboard/DashboardManager";
import NotificationsManager from "@/app/manage/(shell)/notifications/NotificationsManager";
import AccountsManager from "@/app/manage/(shell)/accounts/AccountsManager";
import ClientActivityView from "@/app/manage/(shell)/accounts/[id]/ClientActivityView";
import LeadsManager from "@/app/manage/(shell)/leads/LeadsManager";
import KycRequestsManager from "@/app/manage/(shell)/kyc/KycRequestsManager";
import FundsRequestsManager from "@/app/manage/(shell)/funds/FundsRequestsManager";
import TransfersManager from "@/app/manage/(shell)/transfers/TransfersManager";
import WalletsManager from "@/app/manage/(shell)/wallets/WalletsManager";
import IbRelationshipsManager from "@/app/manage/(shell)/ib/IbRelationshipsManager";
import PositionsManager from "@/app/manage/(shell)/positions/PositionsManager";
import DealingQueueManager from "@/app/manage/(shell)/dealing/DealingQueueManager";
import FeedHealthManager from "@/app/manage/(shell)/feed-health/FeedHealthManager";
import DealsManager from "@/app/manage/(shell)/deals/DealsManager";
import SymbolConfigTable from "@/app/manage/(shell)/symbols/SymbolConfigTable";
import GroupsManager from "@/app/manage/(shell)/groups/GroupsManager";
import MarginManager from "@/app/manage/(shell)/margin/MarginManager";
import RiskSettingsManager from "@/app/manage/(shell)/risk/RiskSettingsManager";
import EmergencyControls from "@/app/manage/(shell)/emergency/EmergencyControls";
import LiquidityManager from "@/app/manage/(shell)/liquidity/LiquidityManager";
import LpRoutingManager from "@/app/manage/(shell)/liquidity-routing/LpRoutingManager";
import ReportsView from "@/app/manage/(shell)/reports/ReportsView";
import TeamManager from "@/app/manage/(shell)/team/TeamManager";
import SettingsManager from "@/app/manage/(shell)/settings/SettingsManager";
import { apiCall } from "@/lib/desktop-api";
import type { ApiBrokerBranding } from "@/lib/trade-api";
import { AdminRealtimeProvider } from "@/lib/admin-realtime";

type ShellInfo = {
  brokerName: string;
  brokerLogoUrl: string | null;
  adminEmail: string | null;
  role: "MANAGER" | "BROKER_ADMIN";
  unreadNotifications: number;
};

// A page's own <main className="mx-auto max-w-..."><PageHeader .../>
// wrapper, reproduced here since a bundled shell has no Server Component
// page.tsx to supply it -- every section below wraps its real Manager
// component in this the same way its real page.tsx does, matching
// title/description/max-width exactly.
function Section({ maxWidth, title, description, children }: { maxWidth: string; title: string; description?: string; children: ReactNode }) {
  return (
    <main className={`mx-auto ${maxWidth}`}>
      <PageHeader title={title} description={description} />
      {children}
    </main>
  );
}

// The bundled Manager/Broker-Admin desktop terminal's real entry point.
// Unlike the website (real multi-page routing across /manage/*), this is
// a single page with an in-memory "current section" switch -- AdminShell
// takes isActive/renderNavLink as props for exactly this reason (see its
// own doc comment). Every section below mounts the exact same
// self-fetching *Manager.tsx component the website's own page.tsx
// renders -- see the bundled-UI architecture plan for why that's possible
// now (every Manager page was inverted from server-props to self-fetch).
export default function App() {
  const [branding, setBranding] = useState<ApiBrokerBranding | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [shellInfo, setShellInfo] = useState<ShellInfo | null>(null);
  const [section, setSection] = useState("/manage/dashboard");
  // Accounts drill-in: clicking an account number on /manage/accounts
  // used to navigate to /manage/accounts/{id} (a real dynamic route) --
  // there's no routing here, so it's tracked as extra in-memory state
  // instead and rendered in place of the accounts list when set.
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  useEffect(() => {
    apiCall<ApiBrokerBranding>("/api/trade/broker-branding")
      .then(setBranding)
      .catch(() => setBranding({ brokerName: "VyXTrader", brokerLogoUrl: "", supportEmail: null, primaryColor: null }));
  }, []);

  async function loadShellInfo() {
    const info = await apiCall<ShellInfo>("/api/manage/shell-info");
    setShellInfo(info);
  }

  if (!loggedIn || !shellInfo) {
    return (
      <div data-surface="manager" className="min-h-dvh antialiased">
        <ManagerLoginForm
          brokerName={branding?.brokerName ?? "Backoffice"}
          logoUrl={branding?.brokerLogoUrl ?? null}
          onAuthenticated={async () => {
            await loadShellInfo();
            setLoggedIn(true);
          }}
        />
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
    isBrokerAdmin
      ? {
          label: "Finance",
          items: [
            { href: "/manage/funds", label: "Deposits & withdrawals" },
            { href: "/manage/transfers", label: "Internal transfers" },
            { href: "/manage/wallets", label: "Wallets" },
            { href: "/manage/ib", label: "IB & affiliates" },
          ],
        }
      : { label: "Finance", items: [{ href: "/manage/wallets", label: "Wallets" }] },
    {
      label: "Trading",
      items: [
        { href: "/manage/positions", label: "Live Exposure" },
        { href: "/manage/dealing", label: "Dealing queue" },
        { href: "/manage/feed-health", label: "Feed health" },
        { href: "/manage/deals", label: "Deals" },
        { href: "/manage/symbols", label: "Symbols" },
        { href: "/manage/groups", label: "Client groups" },
        { href: "/manage/margin", label: "Margin monitoring" },
        ...(isBrokerAdmin ? [{ href: "/manage/risk", label: "Risk rules" }, { href: "/manage/emergency", label: "Emergency controls" }] : []),
      ],
    },
    ...(isBrokerAdmin
      ? [
          {
            label: "Liquidity",
            items: [
              { href: "/manage/liquidity", label: "LPs" },
              { href: "/manage/liquidity-routing", label: "Routing" },
            ],
          },
        ]
      : []),
    {
      label: "Organization",
      items: [
        { href: "/manage/reports", label: "Reports" },
        ...(isBrokerAdmin ? [{ href: "/manage/team", label: "Staff & roles" }] : []),
        { href: "/manage/audit", label: "Audit log" },
        { href: "/manage/security", label: "Security" },
        ...(isBrokerAdmin ? [{ href: "/manage/settings", label: "System settings" }] : []),
      ],
    },
  ];

  const isActive = (href: string) => href === section;
  const renderNavLink = (item: AdminNavItem, children: ReactNode, className: string) => (
    <button
      type="button"
      onClick={() => {
        setSection(item.href);
        setOpenAccountId(null);
      }}
      className={`${className} w-full text-left`}
    >
      {children}
    </button>
  );

  function renderSection(): ReactNode {
    if (section === "/manage/accounts" && openAccountId) {
      return <ClientActivityView accountId={openAccountId} backLink={() => setOpenAccountId(null)} />;
    }
    switch (section) {
      case "/manage/dashboard":
        return (
          <Section maxWidth="max-w-[1400px]" title="Dashboard" description="Overview of your brokerage — last updated just now">
            <DashboardManager />
          </Section>
        );
      case "/manage/notifications":
        return (
          <Section maxWidth="max-w-3xl" title="Notifications" description="System-generated alerts for new leads, KYC submissions, funds requests, and dealing-queue orders.">
            <NotificationsManager onNavigateToSection={setSection} />
          </Section>
        );
      case "/manage/accounts":
        return (
          <Section maxWidth="max-w-[1400px]" title="Trading Accounts">
            <AccountsManager onOpenAccount={setOpenAccountId} />
          </Section>
        );
      case "/manage/leads":
        return (
          <Section maxWidth="max-w-[1400px]" title="Leads">
            <LeadsManager />
          </Section>
        );
      case "/manage/kyc":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-5xl" title="KYC" description="Identity verification submissions. View front/back document photos before approving or rejecting.">
            <KycRequestsManager />
          </Section>
        ) : null;
      case "/manage/funds":
        return isBrokerAdmin ? (
          <Section
            maxWidth="max-w-5xl"
            title="Funds"
            description="Deposit and withdrawal requests submitted by traders. Approving moves real balance; rejecting leaves it untouched. Withdrawals require two different staff members (maker-checker)."
          >
            <FundsRequestsManager />
          </Section>
        ) : null;
      case "/manage/transfers":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-[1400px]" title="Internal transfers" description="Move balance between two accounts on this broker. Both sides are ledger-backed.">
            <TransfersManager />
          </Section>
        ) : null;
      case "/manage/wallets":
        return (
          <Section maxWidth="max-w-[1400px]" title="Wallets" description="Balance and credit per account.">
            <WalletsManager />
          </Section>
        );
      case "/manage/ib":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-5xl" title="Introducing Brokers">
            <IbRelationshipsManager />
          </Section>
        ) : null;
      case "/manage/positions":
        return (
          <Section maxWidth="max-w-[1400px]" title="Live Exposure">
            <PositionsManager />
          </Section>
        );
      case "/manage/dealing":
        return (
          <Section maxWidth="max-w-[1400px]" title="Dealing queue">
            <DealingQueueManager />
          </Section>
        );
      case "/manage/feed-health":
        return (
          <Section
            maxWidth="max-w-4xl"
            title="Feed health"
            description="Tick-pipeline latency and health, end to end. Not deployed publicly yet -- see the Tick Pipeline Audit -- so this shows real numbers only against a local dev stack."
          >
            <FeedHealthManager />
          </Section>
        );
      case "/manage/deals":
        return (
          <Section maxWidth="max-w-[1400px]" title="Deals">
            <DealsManager />
          </Section>
        );
      case "/manage/symbols":
        return (
          <Section
            maxWidth="max-w-[1400px]"
            title="Symbols"
            description="Spread markup, lot limits, swap, and commission per symbol for this broker. A symbol with no saved row yet shows the platform default — saving it creates the row."
          >
            <SymbolConfigTable />
          </Section>
        );
      case "/manage/groups":
        return (
          <Section
            maxWidth="max-w-[1400px]"
            title="Groups"
            description="Settings templates for accounts — assigning an account to a group applies the group's leverage to that account immediately. Margin-call/stop-out levels are stored here but not yet enforced by the trading engine."
          >
            <GroupsManager />
          </Section>
        );
      case "/manage/margin":
        return (
          <Section
            maxWidth="max-w-[1400px]"
            title="Margin monitoring"
            description="Every account with an open position, sorted most-at-risk first. Informational only — not yet enforced automatically."
          >
            <MarginManager />
          </Section>
        );
      case "/manage/risk":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-4xl" title="Risk" description="Broker-wide trading controls. Existing open positions are never touched by these — they only affect new orders.">
            <RiskSettingsManager />
          </Section>
        ) : null;
      case "/manage/emergency":
        return isBrokerAdmin ? (
          <Section
            maxWidth="max-w-2xl"
            title="Emergency controls"
            description="The broker-wide kill switch. Existing open positions are never touched by this — it only blocks new orders."
          >
            <EmergencyControls />
          </Section>
        ) : null;
      case "/manage/liquidity":
        return isBrokerAdmin ? (
          <Section
            maxWidth="max-w-[1400px]"
            title="Liquidity providers"
            description="Pre-integration roster only -- no real LP connection exists yet. Status is manually tracked, not detected."
          >
            <LiquidityManager />
          </Section>
        ) : null;
      case "/manage/liquidity-routing":
        return isBrokerAdmin ? (
          <Section
            maxWidth="max-w-[1200px]"
            title="LP routing rules"
            description="Intended routing, recorded before the real integration exists -- no execution path reads this yet."
          >
            <LpRoutingManager />
          </Section>
        ) : null;
      case "/manage/reports":
        return (
          <Section maxWidth="max-w-[1400px]" title="Reports" description="Trading volume, revenue, and client acquisition — trailing 30 days">
            <ReportsView />
          </Section>
        );
      case "/manage/team":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-[1400px]" title="Team">
            <TeamManager />
          </Section>
        ) : null;
      case "/manage/audit":
        return (
          <Section
            maxWidth="max-w-[1400px]"
            title="Audit log"
            description="Every sensitive action taken by broker staff, fully logged. Double-click a row to open what it changed."
          >
            <AuditLogTable />
          </Section>
        );
      case "/manage/security":
        return (
          <Section maxWidth="max-w-[720px]" title="Security" description="Two-factor authentication for your own backoffice login.">
            <SecurityManager />
          </Section>
        );
      case "/manage/settings":
        return isBrokerAdmin ? (
          <Section maxWidth="max-w-2xl" title="System settings" description="Broker info (read-only — edited in the Super Admin console) and defaults this team controls.">
            <SettingsManager />
          </Section>
        ) : null;
      default:
        return <p className="text-sm text-[var(--text-3)]">This section isn't available in the desktop app yet.</p>;
    }
  }

  return (
    // Mirrors app/manage/layout.tsx's own root div exactly -- admin-theme.css
    // gates the entire dark theme (backgrounds, text colors, accent) behind
    // this attribute selector; without it every var(--text-*)/var(--bg-*)
    // reference here is unset and the whole app falls back to browser
    // default (white background, black text) once past the hardcoded-dark
    // login screen.
    <div data-surface="manager" className="min-h-dvh antialiased">
     <AdminRealtimeProvider>
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
        {renderSection()}
      </AdminShell>
     </AdminRealtimeProvider>
    </div>
  );
}
