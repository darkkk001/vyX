// Neutral wrapper shared by app/(super-admin)/login (no shell) and
// app/(super-admin)/(shell)/* (AdminShell, see that route group's own
// layout.tsx) -- deliberately has no session/role logic of its own so
// /login can never end up wrapped in the authenticated sidebar.
export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-slate-50 font-sans antialiased">{children}</div>;
}
