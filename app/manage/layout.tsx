// Neutral wrapper shared by app/manage/login (no shell) and
// app/manage/(shell)/* (AdminShell, see that route group's own
// layout.tsx) -- deliberately has no session/role logic of its own so
// /manage/login can never end up wrapped in the authenticated sidebar.
export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-slate-50 font-sans antialiased">{children}</div>;
}
