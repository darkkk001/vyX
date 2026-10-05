-- Owner 2026-10-05: internal (test / staff) accounts, left out of broker-wide figures. Additive, default false.
ALTER TABLE "Account" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;
