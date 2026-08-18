"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

export type AdminNavItem = { href: string; label: string };

export function AdminShell({
  title,
  navItems,
  brokerLabel,
  userLabel,
  children,
}: {
  title: string;
  navItems: AdminNavItem[];
  brokerLabel?: string;
  userLabel?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh bg-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          {brokerLabel ? <p className="mt-0.5 text-xs text-slate-500">{brokerLabel}</p> : null}
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-lg px-3 py-2 text-sm font-medium ${
                  active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        {userLabel ? (
          <div className="border-t border-slate-200 px-5 py-3 text-xs text-slate-500">{userLabel}</div>
        ) : null}
      </aside>
      <main className="min-w-0 flex-1 p-6 md:p-8">{children}</main>
    </div>
  );
}
