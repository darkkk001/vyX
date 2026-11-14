-- Preset avatar: the picture the client chose in Profile (public/avatars/<name>-*.webp); null = initials
ALTER TABLE "Client" ADD COLUMN "avatarPreset" TEXT;
