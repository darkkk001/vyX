import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { brandForHost, icoFromPng, PLATFORM_BRAND, webManifest } from "@/lib/broker-brand";

// Each tenant's browser and home-screen identity comes from its own brand config, found by host.
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;

beforeAll(async () => {
  vi.stubEnv("ROOT_DOMAIN", "vyxtrader.test");
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { return; }
  await prisma.broker.create({ data: { name: `Acme ${s}`, subdomain: `acme-${s}`, customDomain: `my.acme-${s}.com`, logoUrl: "/acme.png", primaryColor: "#112233" } });
});
afterAll(async () => { vi.unstubAllEnvs(); if (dbReachable) await prisma.$disconnect(); });

describe("brand by host", () => {
  it("finds the tenant on its subdomain, its custom domain and the www form", async () => {
    if (!dbReachable) return;
    for (const host of [`acme-${s}.vyxtrader.test`, `my.acme-${s}.com`, `www.my.acme-${s}.com:443`]) {
      expect((await brandForHost(host)).name).toBe(`Acme ${s}`);
    }
  });
  it("the platform's own hosts and an unknown host get the platform brand, never another tenant's", async () => {
    if (!dbReachable) return;
    for (const host of ["vyxtrader.test", "www.vyxtrader.test", `nobody-${s}.com`, null]) expect(await brandForHost(host)).toEqual(PLATFORM_BRAND);
  });
});

describe("files", () => {
  it("the .ico header points at the PNG it wraps", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const ico = icoFromPng(png, 32);
    expect([ico.readUInt16LE(2), ico.readUInt16LE(4), ico[6], ico[7]]).toEqual([1, 1, 32, 32]);
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.subarray(ico.readUInt32LE(18)).equals(png)).toBe(true);
  });
  it("the manifest carries the broker's name, colour and icons", () => {
    const m = webManifest({ name: "Futurix Global Markets Ltd", logoUrl: null, primaryColor: "#112233" });
    expect(m).toMatchObject({ name: "Futurix Global Markets Ltd", short_name: "Futurix Glob", start_url: "/room", display: "standalone", theme_color: "#112233" });
    expect(m.icons.map((i) => i.src)).toEqual(["/brand-icon/192", "/brand-icon/512"]);
  });
});
