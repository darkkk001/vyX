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

// Neutral wrapper shared by app/(super-admin)/login (no shell) and
// app/(super-admin)/(shell)/* (AdminShell) -- deliberately has no
// session/role logic of its own so /login can never end up wrapped in the
// authenticated sidebar. data-surface="super-admin" pulls in the dark
// theme + purple accent tokens from ../admin-theme.css.
export default function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-surface="super-admin" className={`${adminSans.variable} ${adminMono.variable} min-h-dvh antialiased`}>
      {children}
    </div>
  );
}
