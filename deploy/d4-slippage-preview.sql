-- D4 + slippage batch: READ-ONLY preview against the live database (ep-morning-glade). Run with psql, never printing
-- the URL (deploy/d4-slippage-runbook.md, step 0). Writes nothing.
SET default_transaction_read_only = on;

\echo === 1. brokers: pricing engine flag and stored slippage cap (pips -> points x 10)
SELECT b.subdomain, b."pricingEngineEnabled", b."defaultMaxSlippagePips" AS cap_pips,
       b."defaultMaxSlippagePips" * 10 AS cap_points_after
FROM "Broker" b ORDER BY 1;

\echo === 2. symbols by class: digits, and the pip -> point factor the conversion uses
SELECT s.category::text AS class, s.digits, CASE WHEN s.digits >= 1 THEN 10 ELSE 1 END AS points_per_pip,
       count(*) AS symbols, string_agg(s.name, ', ' ORDER BY s.name) AS names
FROM "Symbol" s WHERE EXISTS (SELECT 1 FROM "BrokerSymbol" bs WHERE bs."symbolId" = s.id)
GROUP BY 1, 2 ORDER BY 1, 2;

\echo === 3. account types: every pricing field they carry today, and how many accounts use each
SELECT b.subdomain, t.name, t.enabled, t."spreadMarkup", t."commissionPerLot", t."swapLong", t."swapShort", t."swapFree",
       (SELECT count(*) FROM "Account" a WHERE a."accountTypeId" = t.id) AS accounts,
       (SELECT count(*) FROM "AccountTypeSymbolConfig" c WHERE c."accountTypeId" = t.id) AS per_symbol_rows
FROM "AccountType" t JOIN "Broker" b ON b.id = t."brokerId" ORDER BY 1, 2;

\echo === 4. per account x enabled symbol: effective value BEFORE (type included) vs AFTER (type ignored); rows that differ
WITH x AS (
  SELECT b.subdomain, a."accountNumber", a.status::text AS status, s.name AS symbol,
    -- before: Account symbol > Type symbol > Type flat > Group symbol > broker symbol
    coalesce(asc_."spreadMarkup", tsc."spreadMarkup", t."spreadMarkup", gsc."spreadMarkup", bs."spreadMarkup") AS markup_before,
    coalesce(asc_."spreadMarkup", gsc."spreadMarkup", bs."spreadMarkup") AS markup_after,
    coalesce(asc_."targetTotalSpreadPips", tsc."targetTotalSpreadPips", gsc."targetTotalSpreadPips") AS target_before,
    coalesce(asc_."targetTotalSpreadPips", gsc."targetTotalSpreadPips") AS target_after,
    coalesce(asc_."commissionPerLot", tsc."commissionPerLot", t."commissionPerLot", gsc."commissionPerLot", bs."commissionPerLot") AS comm_before,
    coalesce(asc_."commissionPerLot", gsc."commissionPerLot", bs."commissionPerLot") AS comm_after,
    coalesce(asc_."swapLong", tsc."swapLong", t."swapLong", gsc."swapLong", bs."swapLong") AS swapl_before,
    coalesce(asc_."swapLong", gsc."swapLong", bs."swapLong") AS swapl_after,
    coalesce(asc_."swapShort", tsc."swapShort", t."swapShort", gsc."swapShort", bs."swapShort") AS swaps_before,
    coalesce(asc_."swapShort", gsc."swapShort", bs."swapShort") AS swaps_after,
    coalesce(a."swapFree", t."swapFree", g."swapFree", false) AS swapfree_before,
    coalesce(a."swapFree", g."swapFree", false) AS swapfree_after,
    (SELECT count(*) FROM "Position" p WHERE p."accountId" = a.id AND p."symbolId" = s.id AND p.status = 'OPEN' AND p."deletedAt" IS NULL) AS open_positions
  FROM "Account" a
  JOIN "Broker" b ON b.id = a."brokerId"
  JOIN "BrokerSymbol" bs ON bs."brokerId" = a."brokerId" AND bs.enabled
  JOIN "Symbol" s ON s.id = bs."symbolId"
  LEFT JOIN "AccountType" t ON t.id = a."accountTypeId"
  LEFT JOIN "AccountTypeSymbolConfig" tsc ON tsc."accountTypeId" = a."accountTypeId" AND tsc."symbolId" = s.id
  LEFT JOIN "AccountSymbolConfig" asc_ ON asc_."accountId" = a.id AND asc_."symbolId" = s.id
  LEFT JOIN "Group" g ON g.id = a."groupId"
  LEFT JOIN "GroupSymbolConfig" gsc ON gsc."groupId" = a."groupId" AND gsc."symbolId" = s.id
  WHERE a."accountTypeId" IS NOT NULL
)
SELECT count(*) AS account_symbol_pairs_checked,
       count(*) FILTER (WHERE markup_before IS DISTINCT FROM markup_after OR target_before IS DISTINCT FROM target_after) AS spread_changes,
       count(*) FILTER (WHERE comm_before IS DISTINCT FROM comm_after) AS commission_changes,
       count(*) FILTER (WHERE swapl_before IS DISTINCT FROM swapl_after OR swaps_before IS DISTINCT FROM swaps_after) AS swap_rate_changes,
       count(*) FILTER (WHERE swapfree_before IS DISTINCT FROM swapfree_after) AS swap_free_changes,
       count(*) FILTER (WHERE open_positions > 0) AS pairs_with_open_positions
FROM x;

\echo === 4b. the rows that differ (expected: none)
WITH x AS (
  SELECT b.subdomain, a."accountNumber", s.name AS symbol,
    coalesce(asc_."spreadMarkup", tsc."spreadMarkup", t."spreadMarkup", gsc."spreadMarkup", bs."spreadMarkup") AS markup_before,
    coalesce(asc_."spreadMarkup", gsc."spreadMarkup", bs."spreadMarkup") AS markup_after,
    coalesce(asc_."commissionPerLot", tsc."commissionPerLot", t."commissionPerLot", gsc."commissionPerLot", bs."commissionPerLot") AS comm_before,
    coalesce(asc_."commissionPerLot", gsc."commissionPerLot", bs."commissionPerLot") AS comm_after,
    coalesce(a."swapFree", t."swapFree", g."swapFree", false) AS swapfree_before,
    coalesce(a."swapFree", g."swapFree", false) AS swapfree_after
  FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId"
  JOIN "BrokerSymbol" bs ON bs."brokerId" = a."brokerId" AND bs.enabled JOIN "Symbol" s ON s.id = bs."symbolId"
  LEFT JOIN "AccountType" t ON t.id = a."accountTypeId"
  LEFT JOIN "AccountTypeSymbolConfig" tsc ON tsc."accountTypeId" = a."accountTypeId" AND tsc."symbolId" = s.id
  LEFT JOIN "AccountSymbolConfig" asc_ ON asc_."accountId" = a.id AND asc_."symbolId" = s.id
  LEFT JOIN "Group" g ON g.id = a."groupId"
  LEFT JOIN "GroupSymbolConfig" gsc ON gsc."groupId" = a."groupId" AND gsc."symbolId" = s.id
  WHERE a."accountTypeId" IS NOT NULL
)
SELECT * FROM x WHERE markup_before IS DISTINCT FROM markup_after OR comm_before IS DISTINCT FROM comm_after OR swapfree_before IS DISTINCT FROM swapfree_after ORDER BY 1, 2, 3;

\echo === 5. accounts per broker with a type (the column stays; nothing reads it for pricing after D4)
SELECT b.subdomain, count(*) FILTER (WHERE a."accountTypeId" IS NOT NULL) AS typed, count(*) AS accounts
FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" GROUP BY 1 ORDER BY 1;

\echo === 6. applications carrying a requested type (after D4 a new account never gets one)
SELECT b.subdomain, r.status::text, t.name AS requested_type, count(*)
FROM "LiveAccountRequest" r JOIN "Broker" b ON b.id = r."brokerId" LEFT JOIN "AccountType" t ON t.id = r."accountTypeId"
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

\echo === 7. brokers whose slippage cap the data step would write (expected: those with a pips value)
SELECT count(*) FILTER (WHERE "defaultMaxSlippagePips" IS NOT NULL) AS brokers_with_cap, count(*) AS brokers FROM "Broker";
