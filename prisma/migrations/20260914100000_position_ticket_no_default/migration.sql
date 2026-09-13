-- Position.ticket is assigned by the BEFORE INSERT trigger (opening order's ticket, else the
-- next sequence value). The column DEFAULT added in 20260911200000_numeric_ticket ALSO called
-- nextval() on every insert -- defaults are evaluated before BEFORE triggers run -- so every
-- order+position pair consumed two sequence values and live tickets stepped by 2
-- (#100001157, #100001159, ...). Drop the default; the trigger already handles NULL.
-- Existing tickets are untouched (they already equal the opening order's ticket).
ALTER TABLE "Position" ALTER COLUMN "ticket" DROP DEFAULT;
