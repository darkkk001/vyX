import { Inter, JetBrains_Mono } from "next/font/google";
import "../admin-theme.css";

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
// layout.tsx) -- deliberately has no session/role logic of its own so
// /manage/login can never end up wrapped in the authenticated sidebar.
// data-surface="manager" pulls in the dark theme + green accent tokens
// from ../admin-theme.css for both the login page and the shell.
export default function ManageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-surface="manager" className={`${adminSans.variable} ${adminMono.variable} min-h-dvh antialiased`}>
      {children}
    </div>
  );
}
