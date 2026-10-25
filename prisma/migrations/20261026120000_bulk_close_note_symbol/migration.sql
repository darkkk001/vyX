-- Ledger display fix (owner 2026-10-26): by-symbol bulk closes wrote the literal "Bulk close (SYMBOL)" into
-- Transaction.note. Rewrites that text only, to the closed position's symbol ("Bulk close (XAUUSD)"); amounts,
-- balances, types and dates are untouched. 272 TRADE_PNL rows on live at 2026-10-26, every one linked to a position.
-- Revert: not kept (the old text carried no information the new one lacks).
UPDATE "Transaction" AS t
SET note = 'Bulk close (' || s.name || ')'
FROM "Position" AS p
JOIN "Symbol" AS s ON s.id = p."symbolId"
WHERE t.note = 'Bulk close (SYMBOL)'
  AND t."referenceType" = 'Position'
  AND t."referenceId" = p.id;
