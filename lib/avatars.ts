import { AVATAR_BG, AVATAR_LOSS, AVATAR_PROFIT } from "@/lib/avatar-presets.generated";

// Preset avatars (owner 2026-11-14). The pictures are public/avatars/<name>-1024|256|96.webp (scripts/avatars-build.mjs);
// the lists come from those files (lib/avatar-presets.generated.ts). What a client shows, everywhere (Room top bar,
// Profile, WebTrader badge, share card): the connected Bitmoji, else the chosen preset, else the initials.
// Safe for the browser: no server imports.

export const PROFIT_AVATARS: readonly string[] = AVATAR_PROFIT;
export const LOSS_AVATARS: readonly string[] = AVATAR_LOSS;
/** Every preset once, the profit order then bear: the Profile grid. */
export const ALL_AVATARS: readonly string[] = [...new Set([...AVATAR_PROFIT, ...AVATAR_LOSS])];

export type AvatarSize = 1024 | 256 | 96;
export const isAvatarPreset = (name: unknown): name is string => typeof name === "string" && ALL_AVATARS.includes(name);
export const avatarPath = (name: string, size: AvatarSize) => `/avatars/${name}-${size}.webp`;
export const avatarBg = (name: string) => AVATAR_BG[name] ?? "#0B0B0C";
/** "samurai_moon" -> "Samurai moon" */
export const avatarLabel = (name: string) => { const t = name.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };

export type ShownAvatar = { type: "bitmoji" | "preset" | "none"; preset: string | null; url: string | null; url1024: string | null };

/** bitmoji = the Bitmoji URL to draw (lib/room/bitmoji.ts shownAvatar: flag on, connected), or null. */
export function shownAvatarOf(bitmoji: string | null, preset: string | null | undefined): ShownAvatar {
  const p = isAvatarPreset(preset) ? preset : null;
  if (bitmoji) return { type: "bitmoji", preset: p, url: bitmoji, url1024: bitmoji };
  if (p) return { type: "preset", preset: p, url: avatarPath(p, 256), url1024: avatarPath(p, 1024) };
  return { type: "none", preset: null, url: null, url1024: null };
}
