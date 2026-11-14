import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({ src: "./fonts/Geist-latin.woff2", weight: "100 900", variable: "--font-geist-sans", display: "swap" });

const geistMono = localFont({ src: "./fonts/GeistMono-latin.woff2", weight: "100 900", variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: "VyXTrader",
  description: "B2B white-label broker trading platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
