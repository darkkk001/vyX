-- Stage 4.6 (2026-09-24): PostCloseEffect."seq", the insertion order follow-ups are delivered in within a conflict
-- group (engine/order-management/src/outbox.rs, lib/post-close.ts drainPostCloseBackstop). "createdAt" is only
-- millisecond-precise and ties fell back to the random id.
--
-- Additive: existing rows get numbers in physical order (the table is empty in production: the engine's order
-- management is off).
ALTER TABLE "PostCloseEffect" ADD COLUMN IF NOT EXISTS "seq" BIGSERIAL NOT NULL;
