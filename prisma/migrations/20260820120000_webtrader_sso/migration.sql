-- WebTrader SSO handoff: server-to-server credential for a broker's own
-- external portal to hand off an already-authenticated trader into
-- WebTrader without a manual login form. Null until Super Admin
-- generates one for a broker.
ALTER TABLE "Broker" ADD COLUMN "ssoSecret" TEXT;
CREATE UNIQUE INDEX "Broker_ssoSecret_key" ON "Broker"("ssoSecret");
