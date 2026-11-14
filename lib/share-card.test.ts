import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pipSize } from "@/lib/group-pricing";
import { heroLines, lineTimeframe, linePoints, moneyText, movePercent, movePips, percentText, pipSizeOf, pipsText, shareSlides, shareStart, tradeSeries, type ShareMe } from "@/lib/share-card";
import { ALL_AVATARS, LOSS_AVATARS, PROFIT_AVATARS, isAvatarPreset, shownAvatarOf } from "@/lib/avatars";
import { avatarLists } from "@/scripts/gen-avatar-presets.mjs";

// Share card + preset avatars (owner 2026-11-14, share-card-prototype.html).
describe("share card numbers", () => {
  it("pips = the price difference / the symbol's pip size (10 x its point, the platform's pip rule), signed by the side", () => {
    expect(movePips(3888.13, 3895.19, 2, "BUY")).toBe(70.6);
    expect(pipsText(movePips(3888.13, 3895.19, 2, "BUY"))).toBe("+70.6 pips");
    expect(pipsText(movePips(4100, 4170, 2, "BUY"))).toBe("+700 pips");
    expect(pipsText(movePips(4100, 3861.97, 2, "SELL"))).toBe("+2,380.3 pips");
    expect(pipsText(movePips(1.0862, 1.08273, 5, "BUY"))).toBe("−34.7 pips");
    expect(pipsText(movePips(150.25, 150.1, 3, "SELL"))).toBe("+15 pips");
    expect(pipsText(movePips(96110, 97250.5, 1, "BUY"))).toBe("+1,140.5 pips");
    expect([2, 5, 3, 1].map(pipSizeOf)).toEqual([0.1, 0.0001, 0.01, 1]);
    for (let d = 0; d <= 6; d++) expect(pipSizeOf(d)).toBeCloseTo(pipSize(d).toNumber(), 12); // the same as the pricing's pip
    expect(percentText(movePercent(3888.13, 3895.19, "BUY"))).toBe("+0.18%");
    expect(percentText(movePercent(3881.39, 3880.42, "BUY"))).toBe("−0.02%");
    expect(percentText(movePercent(3881.39, 3880.42, "SELL"))).toBe("+0.02%");
  });
  it("USD first; a tap = pips first; PnL off = no money anywhere", () => {
    const base = { pnl: 7.06, currency: "USD", pips: 70.6, pct: 0.1816 };
    expect(heroLines({ ...base, showPnl: true, view: "money" })).toEqual({ big: "+$7.06", sub: "+70.6 pips · +0.18%" });
    expect(heroLines({ ...base, showPnl: true, view: "pips" })).toEqual({ big: "+70.6 pips", sub: "+$7.06 · +0.18%" });
    const off = heroLines({ ...base, pnl: -9.7, pips: -9.7, pct: -0.025, showPnl: false, view: "money" });
    expect(off).toEqual({ big: "−9.7 pips", sub: "−0.03%" });
    expect(`${off.big}${off.sub}`).not.toContain("$");
    expect(moneyText(-1234.5, "USD")).toBe("−$1,234.50");
    expect(moneyText(12, "AED")).toBe("+12.00 AED");
  });
  it("the line: the trade's own prices from the entry to now, upside down for a SELL (up in profit, down in loss)", () => {
    const opened = Date.parse("2026-11-14T10:00:00Z");
    const candles = [{ bucketStart: "2026-11-14T09:00:00Z", close: "1" }, { bucketStart: "2026-11-14T10:00:00Z", close: "101" }, { bucketStart: "2026-11-14T10:01:00Z", close: "102" }];
    expect(tradeSeries({ side: "BUY", entry: 100, current: 103, openedAtMs: opened, tf: "M1", candles })).toEqual([100, 101, 102, 103]);
    const sell = tradeSeries({ side: "SELL", entry: 103, current: 100, openedAtMs: opened, tf: "M1", candles: [] });
    expect(sell).toEqual([-103, -100]);
    const P = linePoints(sell); // a winning SELL ends at the top
    expect(P[P.length - 1][1]).toBeLessThan(P[0][1]);
    const many = tradeSeries({ side: "BUY", entry: 1, current: 2, openedAtMs: opened, tf: "M1", candles: Array.from({ length: 100 }, (_, i) => ({ bucketStart: new Date(opened + i * 60000).toISOString(), close: String(1 + i / 100) })), max: 24 });
    expect(many).toHaveLength(24);
    expect([many[0], many[23]]).toEqual([1, 2]);
    expect(lineTimeframe(0, 3_600_000)).toBe("M1");
    expect(lineTimeframe(0, 30 * 86_400_000)).toBe("H4");
  });
});

describe("preset avatars", () => {
  it("every file in public/avatars is in the lists (3 sizes each); the lists follow the owner's order", () => {
    const files = readdirSync("public/avatars");
    const names = files.map((f) => /^([a-z0-9_]+)-1024\.webp$/.exec(f)?.[1]).filter(Boolean) as string[];
    expect([...ALL_AVATARS].sort()).toEqual([...names].sort());
    for (const n of names) for (const size of [256, 96]) expect(files).toContain(`${n}-${size}.webp`);
    expect(PROFIT_AVATARS).toEqual(["coin_crown", "coin_laurel", "samurai_moon", "samurai_sun", "bull", "wolf", "phoenix", "owl", "silhouette", "gentleman", "trader", "dragon", "ninja"]);
    expect(LOSS_AVATARS).toEqual(["bear", ...PROFIT_AVATARS]);
  });
  it("a new file joins both lists by itself (after the owner's order, A-Z); bear stays loss-only", () => {
    expect(avatarLists(["zebra", "bear", "wolf", "ape"])).toEqual({ profit: ["wolf", "ape", "zebra"], loss: ["bear", "wolf", "ape", "zebra"] });
    const gen = readFileSync("package.json", "utf8");
    expect(gen).toContain("node scripts/gen-avatar-presets.mjs && prisma generate && next build");
  });
  it("what shows: Bitmoji, else the preset, else the initials", () => {
    expect(shownAvatarOf("https://b/x", "wolf")).toEqual({ type: "bitmoji", preset: "wolf", url: "https://b/x", url1024: "https://b/x" });
    expect(shownAvatarOf(null, "wolf")).toEqual({ type: "preset", preset: "wolf", url: "/avatars/wolf-256.webp", url1024: "/avatars/wolf-1024.webp" });
    expect(shownAvatarOf(null, "nope").type).toBe("none");
    expect(isAvatarPreset("bear")).toBe(true);
  });
  it("the card opens on the client's own avatar in profit (Bitmoji first), on bear in loss", () => {
    const fb = { profit: [...PROFIT_AVATARS], loss: [...LOSS_AVATARS] };
    const me = (type: ShareMe["type"], preset: string | null): ShareMe => ({ type, preset, imageUrl: type === "bitmoji" ? "https://b/x" : null, referralCode: null, registerUrl: null, qr: null, presets: { profit: fb.profit.map((name) => ({ name })), loss: fb.loss.map((name) => ({ name })) } });
    const bm = me("bitmoji", "wolf");
    const sp = shareSlides(bm, false, fb);
    expect(sp[0]).toEqual({ kind: "bitmoji", url: "https://b/x" });
    expect(shareStart(sp, bm, false)).toBe(0);
    const sl = shareSlides(bm, true, fb);
    expect(sl[shareStart(sl, bm, true)]).toEqual({ kind: "preset", name: "bear" });
    const pr = me("preset", "owl");
    const s2 = shareSlides(pr, false, fb);
    expect(s2[shareStart(s2, pr, false)]).toEqual({ kind: "preset", name: "owl" });
    expect(shareStart(shareSlides(null, false, fb), null, false)).toBe(0);
  });
});

describe("share card buttons", () => {
  it("text and link: the referral register link, or the broker's register page without a code", async () => {
    const { shareText, shareLink, telegramShareUrl, xShareUrl, shareFileName } = await import("@/lib/share-card");
    expect(shareText("QoreTrader")).toBe("My trade on QoreTrader");
    expect(shareLink({ registerUrl: "https://my.qoretrader.com/register?ref=JADES79DE" }, "https://my.qoretrader.com")).toBe("https://my.qoretrader.com/register?ref=JADES79DE");
    expect(shareLink({ registerUrl: null }, "https://my.futurixglobal.com")).toBe("https://my.futurixglobal.com/register");
    expect(shareLink(null, "https://my.futurixglobal.com")).toBe("https://my.futurixglobal.com/register");
    expect(telegramShareUrl("My trade on X", "https://a.b/register?ref=C")).toBe("https://t.me/share/url?url=https%3A%2F%2Fa.b%2Fregister%3Fref%3DC&text=My%20trade%20on%20X");
    expect(xShareUrl("My trade on X", "https://a.b/register")).toBe("https://x.com/intent/post?text=My%20trade%20on%20X&url=https%3A%2F%2Fa.b%2Fregister");
    expect(shareFileName("Futurix Global", "XAUUSD")).toBe("futurix-global-xauusd-trade.png");
  });
  it("account nickname: up to 20 characters, empty = none", async () => {
    const { cleanNickname } = await import("@/lib/room/password-rules");
    expect(cleanNickname("  TheBullion  ")).toBe("TheBullion");
    expect(cleanNickname("x".repeat(30))).toBe("x".repeat(20));
    expect(cleanNickname("   ")).toBeNull();
    expect(readFileSync("components/room/AccountDrawer.tsx", "utf8")).toContain('aria-label="Nickname" style={{ flex: 1, minWidth: 0, padding: "7px 10px", fontSize: 13 }} maxLength={20}');
  });
});
