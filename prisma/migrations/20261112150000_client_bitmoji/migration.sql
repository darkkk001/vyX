-- Bitmoji connect (test): the client's avatar image URL from Snap Login Kit
ALTER TABLE "Client" ADD COLUMN "bitmojiAvatarUrl" TEXT;
ALTER TABLE "Client" ADD COLUMN "bitmojiConnectedAt" TIMESTAMPTZ(3);
