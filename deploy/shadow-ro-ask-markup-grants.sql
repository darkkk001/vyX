-- The shadow's read-only role (vyx_shadow_ro) for the account's ask (2026-09-26, engine market_data::ask_markup):
-- the book loader now joins each position's pricing levels, so the role needs these columns / tables too. SELECT only;
-- no personal data (pricing configuration and ids). LIVE-DB STOP GATE: run on Neon (as the owner role) BEFORE the engine
-- build that carries the ask markup is started -- without them every shadow pass fails with "permission denied".
--
-- deploy/neon-shadow-readonly.sql REVOKEs everything and re-grants its own list: add these same lines there as well, or
-- a later re-run of that file drops them again.
--
--   psql "<owner DIRECT_URL>" -v ON_ERROR_STOP=1 -f deploy/shadow-ro-ask-markup-grants.sql
BEGIN;
GRANT SELECT (id, "brokerId", "groupId", "accountTypeId") ON "Account" TO vyx_shadow_ro;
GRANT SELECT (id, "negativeBalanceProtection", "pricingEngineEnabled", "coverageAccountId") ON "Broker" TO vyx_shadow_ro;
GRANT SELECT ("groupId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "GroupSymbolConfig" TO vyx_shadow_ro;
GRANT SELECT (id, "spreadMarkup") ON "AccountType" TO vyx_shadow_ro;
GRANT SELECT ("accountTypeId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "AccountTypeSymbolConfig" TO vyx_shadow_ro;
GRANT SELECT ("accountId", "symbolId", "spreadMarkup", "targetTotalSpreadPips") ON "AccountSymbolConfig" TO vyx_shadow_ro;
COMMIT;
