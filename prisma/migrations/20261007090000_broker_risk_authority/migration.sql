-- Rust cutover Stage 6 (docs/STAGE6-PLAN.md). Additive only: every broker starts WEB (today's behaviour) and
-- demo-only, so adding the columns changes nothing until a broker is flipped on purpose.
CREATE TYPE "RiskAuthority" AS ENUM ('WEB', 'RUST');

ALTER TABLE "Broker" ADD COLUMN "riskAuthority" "RiskAuthority" NOT NULL DEFAULT 'WEB';
ALTER TABLE "Broker" ADD COLUMN "riskAuthorityDemoOnly" BOOLEAN NOT NULL DEFAULT true;
