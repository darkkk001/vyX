"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminShell, type AdminShellProps } from "./AdminShell";
import { AdminRealtimeProvider } from "@/lib/admin-realtime";

// The website's own default wiring for AdminShell's injectable
// isActive/renderNavLink props -- real Next.js routing (usePathname()/
// next/link's <Link>), exactly what AdminShell itself used to hardcode
// before it needed to also work inside a bundled desktop shell (which
// has no `next` package at all, let alone a router). This is the only
// thing app/manage/(shell)/layout.tsx and app/(super-admin)/(shell)/
// layout.tsx should import -- never AdminShell directly.
//
// Also mounts AdminRealtimeProvider (fix/realtime-sync §1) here rather
// than inside AdminShell itself, for the same reason isActive/
// renderNavLink are injected instead of hardcoded: AdminShell stays
// framework-agnostic markup shared with the bundled Tauri shells, which
// mount their own AdminRealtimeProvider directly in their own App.tsx
// instead (manager-shell, admin-shell). `enableRealtime={false}`
// (app/(super-admin)/(shell)/layout.tsx) skips it for Super Admin, whose
// sessions the gateway hard-403s on this stream by design -- see
// AdminRealtimeProvider's own doc comment.
export function NextAdminShell({
  enableRealtime = true,
  ...props
}: Omit<AdminShellProps, "isActive" | "renderNavLink"> & { enableRealtime?: boolean }) {
  const pathname = usePathname();
  return (
    <AdminRealtimeProvider enabled={enableRealtime}>
      <AdminShell
        {...props}
        isActive={(href) => pathname === href || (pathname?.startsWith(`${href}/`) ?? false)}
        renderNavLink={(item, children, className) => (
          <Link href={item.href} className={className}>
            {children}
          </Link>
        )}
      />
    </AdminRealtimeProvider>
  );
}
