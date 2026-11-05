-- Per-broker switch: withdrawals need 2FA. Additive, off for every broker.
ALTER TABLE "Broker" ADD COLUMN "requireWithdrawal2fa" BOOLEAN NOT NULL DEFAULT false;
