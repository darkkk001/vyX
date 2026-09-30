import { Inter, JetBrains_Mono } from "next/font/google";
import "../admin-theme.css";
import { getAdminSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AdminThemeSurface, type AdminThemeMode } from "@/lib/admin-theme";
import { headers } from "next/headers";
import type { Metadata } from "next";

// Step 2 (owner 2026-09-30): every /manage page (the login included, which /manager/login is an alias of) titles the
// browser tab with the broker's own name, e.g. "Futurix Global Backoffice", instead of app/layout.tsx's platform-wide
// "VyXTrader" (seen on futurixglobal.com). Same per-request broker lookup app/(broker)/layout.tsx uses for trader pages.
export async function generateMetadata(): Promise<Metadata> {
  const brokerId = (await headers()).get("x-broker-id");
  if (!brokerId) return {};
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true } });
  return broker ? { title: `${broker.name} Backoffice` } : {};
}

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
