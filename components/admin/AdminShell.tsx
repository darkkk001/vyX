"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

export type AdminNavItem = { href: string; label: string; badge?: number };
export type AdminNavGroup = { label?: string; items: AdminNavItem[] };

function NavGroup({ group, pathname }: { group: AdminNavGroup; pathname: string | null }) {
  return (
    <div className="mb-1">
      {group.label ? (
        <p className="px-2.5 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-wide text-[var(--text-3)]">
          {group.label}
        </p>
      ) : null}
      {group.items.map((item) => {
        const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`relative mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[12.5px] ${
              active
                ? "bg-[var(--bg-3)] text-[var(--text-1)]"
                : "text-[var(--text-2)] hover:bg-[var(--bg-3)] hover:text-[var(--text-1)]"
            }`}
          >
            {active ? (
              <span className="absolute -left-2.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-[var(--accent)]" />
            ) : null}
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="rounded-full bg-[var(--sell)] px-1.5 py-px text-[9.5px] font-bold text-white">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

export function AdminShell({
  title,
  planeTag,
  navGroups,
  bottomNavGroup,
  pageTitle,
  topbarSearch,
  topbarRight,
  children,
}: {
  title: string;
  planeTag?: string;
  navGroups: AdminNavGroup[];
  bottomNavGroup?: AdminNavGroup;
  pageTitle: string;
  topbarSearch?: ReactNode;
  topbarRight: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh bg-[var(--bg-0)]">
      <aside className="flex w-[230px] shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-1)] px-2.5 py-4">
        <div className="flex items-center gap-2.5 px-2 pb-1 pt-1.5">
          <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-[var(--accent)] text-[13px] font-bold text-[#03150c]">
            X
          </div>
          <p className="text-[13px] font-semibold text-[var(--text-1)]">{title}</p>
        </div>
        {planeTag ? (
          <p className="mx-2 mb-3 mt-2 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-bg)] px-2.5 py-1.5 text-center text-[10px] font-semibold tracking-wide text-[var(--accent)]">
            {planeTag}
          </p>
        ) : null}
        <nav className="flex-1">
          {navGroups.map((group, i) => (
            <NavGroup key={group.label ?? i} group={group} pathname={pathname} />
          ))}
        </nav>
        {bottomNavGroup ? (
          <div className="mt-auto border-t border-[var(--border)] pt-2">
            <NavGroup group={bottomNavGroup} pathname={pathname} />
          </div>
        ) : null}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border)] bg-[var(--bg-1)] px-5">
          <p className="text-[15px] font-semibold text-[var(--text-1)]">{pageTitle}</p>
          {topbarSearch}
          <div className="ml-auto flex items-center gap-3.5">{topbarRight}</div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}
