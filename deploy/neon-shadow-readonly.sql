-- Rust cutover Stage 5, guard 1: the read-only Neon role the shadow monitor + reconciler read the book with
-- (engine env VYX_SHADOW_DATABASE_URL). A STANDING credential (soak, then after cutover), so LEAST PRIVILEGE:
-- - only the tables the shadow path reads, and on the ones holding personal or secret data (Account, Broker,
--   Transaction, Notification) only the columns it reads: no email, name, phone, passwordHash, ssoSecret, and no
--   client / KYC tables at all;
-- - SELECT only; sessions default to read-only; no default privileges, so a table added later is NOT readable and the
--   shadow fails loudly until it is granted here on purpose.
-- The engine verifies at startup that this role cannot INSERT / UPDATE / DELETE any money table and cannot read
-- Account.passwordHash, and refuses SHADOW otherwise (engine/order-management/src/shadow.rs connect_read_only_book).
-- The scratch gate (scripts/load/shadow-gate.sh) runs THIS file and the shadow through the resulting role, so the
-- grants below are exactly what the shadow needs.
--
-- Run ONCE on the LIVE database (ep-morning-glade) as neondb_owner; the password is a psql variable, never typed into
-- this file (so it cannot land in git):
--   psql "<DIRECT_URL of ep-morning-glade>" -v ON_ERROR_STOP=1 -v shadow_pw='<strong password>' -f deploy/neon-shadow-readonly.sql
-- Then on the VPS, in start-engine.cmd (above the engine launch line):
--   set VYX_SHADOW_DATABASE_URL=postgresql://vyx_shadow_ro:<PASSWORD>@ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require
-- Idempotent: re-running resets the password and re-applies exactly these grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vyx_shadow_ro') THEN
    CREATE ROLE vyx_shadow_ro LOGIN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO vyx_shadow_ro', current_database());
END
$$;
ALTER ROLE vyx_shadow_ro WITH LOGIN PASSWORD :'shadow_pw';
ALTER ROLE vyx_shadow_ro SET default_transaction_read_only = on;
GRANT USAGE ON SCHEMA public TO vyx_shadow_ro;

-- start from nothing (a re-run never keeps an older, wider grant)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vyx_shadow_ro;

-- book tables with no personal data: whole table, SELECT only. ("LivePrice" stays: the loader's SQL still joins it,
-- but in production the book's prices come from the engine's in-memory ticks and the joined values are ignored.)
GRANT SELECT ON "Position", "Symbol", "BrokerSymbol", "TradingSession", "Group", "LivePrice",
                "MirrorRule", "MirrorLink", "PostCloseEffect" TO vyx_shadow_ro;

-- tables with personal or secret data: only the columns the shadow reads
GRANT SELECT (id, "brokerId", "groupId", "accountTypeId", balance, credit, leverage, currency, "marginCallNotifiedAt") ON "Account" TO vyx_shadow_ro;
GRANT SELECT (id, "negativeBalanceProtection", "pricingEngineEnabled", "coverageAccountId") ON "Broker" TO vyx_shadow_ro;
-- the account's ask (2026-09-26, deploy/shadow-ro-ask-markup-grants.sql): a SELL closes at its account's marked-up ask,
-- resolved group -> account type -> account (market_data::ask_markup, lib/ask-markup.ts)
GRANT SELECT ("groupId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "GroupSymbolConfig" TO vyx_shadow_ro;
GRANT SELECT (id, "spreadMarkup") ON "AccountType" TO vyx_shadow_ro;
GRANT SELECT ("accountTypeId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "AccountTypeSymbolConfig" TO vyx_shadow_ro;
GRANT SELECT ("accountId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "AccountSymbolConfig" TO vyx_shadow_ro;
GRANT SELECT (id, "accountId", type, "referenceType", "referenceId", note, amount, "createdAt") ON "Transaction" TO vyx_shadow_ro;
GRANT SELECT (id, "accountId", type, body, "createdAt") ON "Notification" TO vyx_shadow_ro;
