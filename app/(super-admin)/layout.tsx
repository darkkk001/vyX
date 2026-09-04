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

// Neutral wrapper shared by app/(super-admin)/login (no shell) and
// app/(super-admin)/(shell)/* (AdminShell) -- deliberately has no
// *role/redirect* logic of its own so /login can never end up wrapped in
// the authenticated sidebar. data-surface="super-admin" pulls in the
// theme tokens from ../admin-theme.css; the one session read below is
// read-only (the signed-in admin's saved theme, if any), same reasoning
// as app/manage/layout.tsx's identical block.
export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  let initialMode: AdminThemeMode = "light";
  if (session) {
    const admin = await prisma.adminUser.findUnique({ where: { id: session.adminId }, select: { theme: true } });
    if (admin?.theme === "dark") initialMode = "dark";
  }

  return (
    <AdminThemeSurface
      surface="super-admin"
      initialMode={initialMode}
      saveUrl="/api/admin/theme"
      className={`${adminSans.variable} ${adminMono.variable} min-h-dvh antialiased`}
    >
      {children}
    </AdminThemeSurface>
  );
}
