-- Data-only fix: the original 20260903215310_account_type_scaffold
-- migration seeded "Standard"/"Zero" descriptions with a double-hyphen
-- ("--") standing in for an em-dash -- an AI-fingerprint pattern this
-- project deliberately avoids in user-facing text (see scripts/check-
-- no-dashes.mjs). That migration is already applied everywhere (dev and
-- prod) and its own file is left untouched -- editing an already-applied
-- migration's SQL would silently break its recorded checksum, which is
-- exactly the kind of drift this project's own migration discipline
-- exists to catch. This is a NEW migration instead, correcting only the
-- two rows' text.
--
-- Scoped to the EXACT original string (not name='Standard'/'Zero'
-- broker-wide) so a broker that already customized their own
-- Standard/Zero description away from the seeded default is left alone
-- -- this only touches rows nobody has edited since the original seed.
UPDATE "AccountType"
SET "description" = 'Balanced spread and commission, suitable for most traders'
WHERE "description" = 'Balanced spread and commission -- suitable for most traders';

UPDATE "AccountType"
SET "description" = 'Near-zero spread, higher commission, for high-volume traders'
WHERE "description" = 'Near-zero spread, higher commission -- for high-volume traders';
