import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AdminShell, type AdminNavGroup, type AdminNavItem } from "@/components/admin/AdminShell";
import { LogoutButton } from "@/components/admin/LogoutButton";
import { PageHeader } from "@/components/ui/PageHeader";
import AuditLogTable from "@/app/(super-admin)/(shell)/audit/AuditLogTable";
import BrokersManager from "@/app/(super-admin)/(shell)/brokers/BrokersManager";
import TrialsManager from "@/app/(super-admin)/(shell)/trials/TrialsManager";
import BillingManager from "@/app/(super-admin)/(shell)/billing/BillingManager";
import HealthManager from "@/app/(super-admin)/(shell)/health/HealthManager";
import SecurityManager from "@/app/(super-admin)/(shell)/security/SecurityManager";
import NotificationsManager from "@/app/(super-admin)/(shell)/notifications/NotificationsManager";
import AdminsManager from "@/app/(super-admin)/(shell)/admins/AdminsManager";
import { apiCall } from "@/lib/desktop-api";
import { initialsFrom } from "@/lib/format";
import { AdminRealtimeProvider } from "@/lib/admin-realtime";

type ShellInfo = { adminEmail: string | null; unreadNotifications: number };

// A page's own <main className="mx-auto max-w-..."><PageHeader .../>
// wrapper, reproduced here since a bundled shell has no Server Component
// page.tsx to supply it -- matches each real page.tsx's title/
// description/max-width exactly.
function Section({ maxWidth, title, description, children }: { maxWidth: string; title: string; description?: string; children: ReactNode }) {
  return (
    <main className={`mx-auto ${maxWidth}`}>
      <PageHeader title={title} description={description} />
      {children}
    </main>
  );
}

// The bundled Super Admin desktop terminal's real entry point. Same
// in-memory "current section" pattern as manager-shell's own App.tsx
// (AdminShell takes isActive/renderNavLink as props for exactly this
// reason). No broker branding to fetch -- Super Admin is a fixed,
// single-tenant platform surface, not broker-scoped. Every section below
// mounts the exact same self-fetching *Manager.tsx component the
// website's own page.tsx renders -- see the bundled-UI architecture plan
// for why that's possible now (every Super Admin page was inverted from
// server-props/inline-Server-Component to self-fetch).
export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [shellInfo, setShellInfo] = useState<ShellInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [section, setSection] = useState("/brokers");

  async function loadShellInfo() {
    const info = await apiCall<ShellInfo>("/api/admin/shell-info");
    setShellInfo(info);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = await apiCall<{ requiresTwoFactor?: true; pendingToken?: string }>("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (body.requiresTwoFactor) {
        setPendingToken(body.pendingToken ?? null);
        return;
      }
      await loadShellInfo();
      setLoggedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiCall("/api/admin/login/verify-2fa", { method: "POST", body: JSON.stringify({ pendingToken, code }) });
      await loadShellInfo();
      setLoggedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!loggedIn || !shellInfo) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#07090C] px-4">
        <div className="w-full max-w-sm rounded-xl border border-[#1e242c] bg-[#0b0f14] p-6">
          <div className="mb-6 flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[#7c6fff] text-sm font-bold text-[#0a0714]">
              X
            </div>
            <h1 className="text-lg font-semibold text-[#edeff2]">vyX Super Admin</h1>
          </div>
          {pendingToken ? (
            <form onSubmit={handleVerify} className="flex flex-col gap-4">
              <p className="text-sm text-[#8b93a1]">Enter the 6-digit code from your authenticator app.</p>
              <input
                inputMode="numeric"
                maxLength={6}
                autoFocus
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="rounded-md border border-[#1A222C] bg-[#0E1319] px-3 py-2.5 text-center font-mono text-lg tracking-[4px] text-[#edeff2] outline-none"
              />
              {error ? <div className="text-sm text-[#ea3943]">{error}</div> : null}
              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="rounded-md bg-[#7c6fff] px-3 py-2.5 font-semibold text-[#0a0714]"
              >
                {submitting ? "Verifying..." : "Verify"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <input
                placeholder="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-md border border-[#1A222C] bg-[#0E1319] px-3 py-2.5 text-[#edeff2] outline-none"
              />
              <input
                placeholder="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-md border border-[#1A222C] bg-[#0E1319] px-3 py-2.5 text-[#edeff2] outline-none"
              />
              {error ? <div className="text-sm text-[#ea3943]">{error}</div> : null}
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-[#7c6fff] px-3 py-2.5 font-semibold text-[#0a0714]"
              >
                {submitting ? "Signing in..." : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // Same structure as app/(super-admin)/(shell)/layout.tsx's own
  // navGroups -- hrefs are just section keys here, not real routes.
  const navGroups: AdminNavGroup[] = [
    { label: "Tenants", items: [{ href: "/brokers", label: "All brokers" }, { href: "/trials", label: "Trials pending" }] },
    { label: "Billing", items: [{ href: "/billing", label: "Plans & billing" }] },
    {
      label: "Platform",
      items: [
        { href: "/health", label: "Platform health" },
        { href: "/audit", label: "Audit log" },
        { href: "/security", label: "Security" },
        {
          href: "/notifications",
          label: "Notifications",
          ...(shellInfo.unreadNotifications > 0 ? { badge: shellInfo.unreadNotifications } : {}),
        },
      ],
    },
  ];
  const bottomNavGroup: AdminNavGroup = { items: [{ href: "/admins", label: "Admins" }] };

  const isActive = (href: string) => href === section;
  const renderNavLink = (item: AdminNavItem, children: ReactNode, className: string) => (
    <button type="button" onClick={() => setSection(item.href)} className={`${className} w-full text-left`}>
      {children}
    </button>
  );

  function renderSection(): ReactNode {
    switch (section) {
      case "/brokers":
        return (
          <Section maxWidth="max-w-[1400px]" title="All brokers" description="Every broker tenant licensed on VyXTrader">
            <BrokersManager />
          </Section>
        );
      case "/trials":
        return (
          <Section maxWidth="max-w-4xl" title="Trials pending" description="Brokers currently on a trial period">
            <TrialsManager />
          </Section>
        );
      case "/billing":
        return (
          <Section maxWidth="max-w-[1200px]" title="Plans & billing" description="Subscription status per broker — billing is separate from the trading ledger">
            <BillingManager />
          </Section>
        );
      case "/health":
        return (
          <Section maxWidth="max-w-4xl" title="Platform health" description="Service status across the platform">
            <HealthManager />
          </Section>
        );
      case "/audit":
        return (
          <Section maxWidth="max-w-[1400px]" title="Audit log" description="Every platform-level and cross-tenant action, fully logged">
            <AuditLogTable />
          </Section>
        );
      case "/security":
        return (
          <Section
            maxWidth="max-w-[720px]"
            title="Security"
            description="This login is the only way in to platform-wide control -- every broker's tenants, billing, and admin accounts. Two-factor authentication is strongly recommended."
          >
            <SecurityManager onLoggedOut={() => setLoggedIn(false)} />
          </Section>
        );
      case "/notifications":
        return (
          <Section maxWidth="max-w-3xl" title="Notifications" description="Backoffice staff password-reset requests, across every broker.">
            <NotificationsManager />
          </Section>
        );
      case "/admins":
        return (
          <Section maxWidth="max-w-4xl" title="Admins" description="Broker-scoped admin accounts across every tenant">
            <AdminsManager />
          </Section>
        );
      default:
        return <p className="text-sm text-[var(--text-3)]">This section isn&apos;t available in the desktop app yet.</p>;
    }
  }

  return (
    // Same fix as manager-shell's App.tsx -- see its own comment. Mirrors
    // app/(super-admin)/layout.tsx's root data-surface="super-admin" div.
    <div data-surface="super-admin" className="min-h-dvh antialiased">
     <AdminRealtimeProvider>
      <AdminShell
        title="vyX Super Admin"
        planeTag="PLATFORM CONTROL PLANE"
        pageTitle="Super Admin"
        navGroups={navGroups}
        bottomNavGroup={bottomNavGroup}
        isActive={isActive}
        renderNavLink={renderNavLink}
        topbarRight={
          <div className="flex items-center gap-2">
            <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-[var(--accent)]/35 bg-[var(--accent-bg)] text-[11px] font-semibold text-[var(--accent)]">
              {initialsFrom(shellInfo.adminEmail ?? "SUPER_ADMIN")}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-semibold text-[var(--text-1)]">{shellInfo.adminEmail ?? "Super Admin"}</span>
              <span className="text-[10px] text-[var(--text-3)]">Platform Owner</span>
            </div>
            <LogoutButton loginHref="/login" onLoggedOut={() => setLoggedIn(false)}>
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
