-- Rust cutover Stage 6. Additive only: every broker starts WEB (today's behaviour) and demo-only, so adding the columns changes nothing until a broker is flipped on purpose. Constant defaults are metadata-only on Postgres 11+ (no table rewrite). Idempotent.
DO $$ BEGIN
  CREATE TYPE "RiskAuthority" AS ENUM ('WEB', 'RUST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "riskAuthority" "RiskAuthority" NOT NULL DEFAULT 'WEB';
ALTER TABLE "Broker" ADD COLUMN IF NOT EXISTS "riskAuthorityDemoOnly" BOOLEAN NOT NULL DEFAULT true;
