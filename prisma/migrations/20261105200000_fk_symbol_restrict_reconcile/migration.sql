-- Drift reconcile (owner 2026-11-05): on live, AccountSymbolConfig_symbolId_fkey and AccountTypeSymbolConfig_symbolId_fkey were
-- changed out of band to ON DELETE CASCADE. The schema (a required relation, no onDelete = Restrict) and the migration that
-- created them (20260907120000_pricing_engine_new_tables_and_flag) say ON DELETE RESTRICT ON UPDATE CASCADE. Re-create both
-- exactly as that migration defined them. On a database built from the migrations this is a no-op (RESTRICT -> RESTRICT).
-- Verified read-only on live first (2026-11-05): both confdeltype = c (CASCADE), confupdtype = c, validated; both tables 0 rows.
ALTER TABLE "AccountSymbolConfig" DROP CONSTRAINT "AccountSymbolConfig_symbolId_fkey";
ALTER TABLE "AccountSymbolConfig" ADD CONSTRAINT "AccountSymbolConfig_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccountTypeSymbolConfig" DROP CONSTRAINT "AccountTypeSymbolConfig_symbolId_fkey";
ALTER TABLE "AccountTypeSymbolConfig" ADD CONSTRAINT "AccountTypeSymbolConfig_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "Symbol"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
