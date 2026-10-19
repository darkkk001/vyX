-- A broker created outside the Super Admin route (seed, script, direct insert) starts with staff 2FA Required.
-- Default only: no existing row changes (QoreTrader stays Optional; rows that set false explicitly are unaffected).
ALTER TABLE "Broker" ALTER COLUMN "requireAdmin2fa" SET DEFAULT true;
