-- Phase D: delegatable permissions for MANAGER admins.
ALTER TABLE "AdminUser" ADD COLUMN "extraPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
