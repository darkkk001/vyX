"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminShell, type AdminShellProps } from "./AdminShell";

// The website's own default wiring for AdminShell's injectable
// isActive/renderNavLink props -- real Next.js routing (usePathname()/
// next/link's <Link>), exactly what AdminShell itself used to hardcode
// before it needed to also work inside a bundled desktop shell (which
// has no `next` package at all, let alone a router). This is the only
// thing app/manage/(shell)/layout.tsx and app/(super-admin)/(shell)/
// layout.tsx should import -- never AdminShell directly.
export function NextAdminShell(props: Omit<AdminShellProps, "isActive" | "renderNavLink">) {
  const pathname = usePathname();
  return (
    <AdminShell
      {...props}
      isActive={(href) => pathname === href || (pathname?.startsWith(`${href}/`) ?? false)}
      renderNavLink={(item, children, className) => (
        <Link href={item.href} className={className}>
          {children}
        </Link>
      )}
    />
  );
}
