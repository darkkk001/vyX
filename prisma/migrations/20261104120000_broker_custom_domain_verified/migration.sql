-- White-label custom domain check (2026-11-04), additive.
ALTER TABLE "Broker" ADD COLUMN "customDomainVerifiedAt" TIMESTAMPTZ(3);
-- Keep today's behaviour: every configured custom domain already redirects, except Futurix's, whose redirect
-- was skipped in middleware until its domain is live (it is checked again from the Super Admin broker screen).
UPDATE "Broker" SET "customDomainVerifiedAt" = CURRENT_TIMESTAMP WHERE "customDomain" IS NOT NULL AND subdomain <> 'futurixglobal';
