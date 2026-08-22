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

// Root-domain sibling to app/manage/layout.tsx's own wrapper (same
// data-surface="manager" tokens) -- this page runs on the bare domain,
// never under a resolved broker, so it can't reuse that layout directly
// (which lives under app/manage/, broker-subdomain territory).
export default function ManageLaunchLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-surface="manager" className={`${adminSans.variable} ${adminMono.variable} min-h-dvh antialiased`}>
      {children}
    </div>
  );
}
