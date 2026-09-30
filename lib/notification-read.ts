import type { Prisma } from "@prisma/client";

// web3 (issues.md 324, owner 2026-09-30): a staff notification is read FOR ONE STAFF MEMBER when the older shared
// Notification.readAt is set (legacy marks, and "handled for everyone" such as a resolved password-reset request) or
// that person has their own NotificationRead row. Staff rows only (accountId null); a trader-copy row is never shown.
export function unreadStaffNotificationsFor(brokerId: string, adminId: string): Prisma.NotificationWhereInput {
  return { brokerId, accountId: null, readAt: null, reads: { none: { adminId } } };
}
