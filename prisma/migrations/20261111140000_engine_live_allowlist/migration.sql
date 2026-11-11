-- Live cutover (owner 2026-11-11), DORMANT: the per-account engine allowlist and its broker-level flag.
-- Both default false: no account is engine-enabled for live, every rule stays exactly the DEMO-only one.
-- Additive only (two NOT NULL columns with a constant default: no table rewrite on Postgres 11+).
ALTER TABLE "Broker" ADD COLUMN "engineLiveAllowlistOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "engineLiveEnabled" BOOLEAN NOT NULL DEFAULT false;
