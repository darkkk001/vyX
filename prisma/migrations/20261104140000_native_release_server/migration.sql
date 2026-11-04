-- Consolidated native release, server part (owner 2026-11-04). Additive only.

-- web security batch 1 S1: a staff password reset confines the trader to choosing a new password
ALTER TABLE "Account" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
