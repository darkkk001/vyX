-- web3 (issues.md 324, owner 2026-09-30): notifications are read PER STAFF MEMBER, not shared.
-- Additive only: one new table. "Notification"."readAt" is kept and keeps its meaning (the older shared mark, and
-- "handled for everyone" such as a resolved password-reset request); a staff member has read a notification when
-- readAt is set OR they have their own row here. No existing row is changed.

CREATE TABLE IF NOT EXISTS "NotificationRead" (
    "notificationId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("notificationId", "adminId")
);

CREATE INDEX IF NOT EXISTS "NotificationRead_adminId_idx" ON "NotificationRead"("adminId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationRead_notificationId_fkey') THEN
    ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_notificationId_fkey"
      FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NotificationRead_adminId_fkey') THEN
    ALTER TABLE "NotificationRead" ADD CONSTRAINT "NotificationRead_adminId_fkey"
      FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
