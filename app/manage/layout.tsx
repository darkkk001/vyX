import { Inter, JetBrains_Mono } from "next/font/google";
import "../admin-theme.css";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AdminThemeSurface, type AdminThemeMode } from "@/lib/admin-theme";

const adminSans = Inter({
  variable: "--font-admin-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const adminMono = JetBrains_Mono({
  variable: "--font-admin-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Neutral wrapper shared by app/manage/login (no shell) and
// app/manage/(shell)/* (AdminShell, see that route group's own
// layout.tsx) -- deliberately has no *role/redirect* logic of its own so
// /manage/login can never end up wrapped in the authenticated sidebar.
// data-surface="manager" pulls in the theme tokens from ../admin-theme.css
// for both the login page and the shell; the one session read below is
// read-only (just the signed-in admin's saved theme, if any) and adds no
// gating -- an invalid/missing session still renders normally, just with
// the "light" default. See lib/admin-theme.tsx's AdminThemeSurface.
export default async function ManageLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  let initialMode: AdminThemeMode = "light";
  if (session) {
    const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { theme: true } });
    if (admin?.theme === "dark") initialMode = "dark";
  }

  return (
    <AdminThemeSurface
      surface="manager"
      initialMode={initialMode}
      saveUrl="/api/manage/theme"
      className={`${adminSans.variable} ${adminMono.variable} min-h-dvh antialiased`}
    >
      {children}
    </AdminThemeSurface>
  );
}
