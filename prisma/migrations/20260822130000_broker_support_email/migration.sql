-- White-label: a broker's own support contact for WebTrader's Help menu,
-- instead of the platform's own address. Null = hide the menu item.
ALTER TABLE "Broker" ADD COLUMN "supportEmail" TEXT;
