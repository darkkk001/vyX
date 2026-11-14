import localFont from "next/font/local";
import "../admin-theme.css";

const adminSans = localFont({ src: "../fonts/Inter-latin.woff2", weight: "100 900", variable: "--font-admin-sans", display: "swap" });
const adminMono = localFont({ src: "../fonts/JetBrainsMono-latin.woff2", weight: "100 800", variable: "--font-admin-mono", display: "swap" });

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
