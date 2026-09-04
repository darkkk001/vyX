"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { AdminShell, type AdminShellProps } from "./AdminShell";
import { AdminRealtimeProvider, useAdminEventStream, type AdminEvent } from "@/lib/admin-realtime";

// Mirrors lib/dealer-activity.ts's own NOTIFY_ACTIONS set -- that file is
// server-only (writes the actual Notification row), so this is a small,
// deliberate duplication rather than a shared import. Keep in sync with
// that file if the notify-worthy action set ever changes.
const DEALER_NOTIFY_ACTIONS = new Set(["ORDER_PLACED", "ORDER_MODIFIED", "ORDER_TRIGGERED"]);

// Dealer awareness §2 -- the sidebar's Notifications badge (layout.tsx's
// own server-computed unreadNotifications count) previously only updated
// on the next full navigation/Server Component render, so a dealer
// watching the shell without switching pages never saw the count rise
// when a new DEALER_ACTIVITY notification landed. This tracks the same
// DealerActivity event the activity feed listens to (see
// components/admin/DealerActivityFeed.tsx) and live-increments on top of
// the server-provided initial count for exactly the notify-worthy subset
// -- every other notification type (KYC, funds, leads, ...) still updates
// on next navigation as before, unchanged.
function useLiveNotificationBadge(initialCount: number): number {
  const [delta, setDelta] = useState(0);
  useAdminEventStream((event: AdminEvent) => {
    if (event.type !== "DealerActivity") return;
    if (event.is_dealing_group && DEALER_NOTIFY_ACTIONS.has(String(event.action))) {
      setDelta((d) => d + 1);
    }
  });
  return initialCount + delta;
}

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
  initialUnreadNotifications = 0,
  notificationsHref = "/manage/notifications",
  ...props
}: Omit<AdminShellProps, "isActive" | "renderNavLink"> & {
  enableRealtime?: boolean;
  // Server-computed count from layout.tsx (prisma.notification.count) --
  // this component owns live-incrementing it from there. Not read at all
  // when enableRealtime is false (Super Admin never mounts the provider
  // the live-badge hook needs, and has no dealer-activity concept anyway).
  initialUnreadNotifications?: number;
  notificationsHref?: string;
}) {
  const pathname = usePathname();
  return (
    <AdminRealtimeProvider enabled={enableRealtime}>
      <NextAdminShellInner
        {...props}
        pathname={pathname}
        initialUnreadNotifications={initialUnreadNotifications}
        notificationsHref={notificationsHref}
      />
    </AdminRealtimeProvider>
  );
}

// Split out from NextAdminShell itself so useLiveNotificationBadge's
// useAdminEventStream call runs as a DESCENDANT of the
// AdminRealtimeProvider mounted above -- calling it directly in
// NextAdminShell's own body would read a null context (a component
// doesn't sit "inside" the provider it itself returns).
function NextAdminShellInner({
  pathname,
  initialUnreadNotifications,
  notificationsHref,
  navGroups,
  ...props
}: Omit<AdminShellProps, "isActive" | "renderNavLink"> & {
  pathname: string | null;
  initialUnreadNotifications: number;
  notificationsHref: string;
}) {
  const liveUnreadCount = useLiveNotificationBadge(initialUnreadNotifications);
  const liveNavGroups = useMemo(
    () =>
      navGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.href === notificationsHref
            ? { ...item, ...(liveUnreadCount > 0 ? { badge: liveUnreadCount } : {}) }
            : item
        ),
      })),
    [navGroups, notificationsHref, liveUnreadCount]
  );

  return (
    <AdminShell
      {...props}
      navGroups={liveNavGroups}
      isActive={(href) => pathname === href || (pathname?.startsWith(`${href}/`) ?? false)}
      renderNavLink={(item, children, className) => (
        <Link href={item.href} className={className}>
          {children}
        </Link>
      )}
    />
  );
}
