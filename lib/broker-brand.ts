import "server-only";
import { prisma } from "@/lib/prisma";

// A tenant's browser and home-screen identity, from its brand config (Broker.logoUrl, name, primaryColor). These paths are
// fetched by browsers with no page around them and sit outside middleware.ts (its matcher skips dotted paths), so the
// broker comes from the Host header here. No logo, or one that cannot be drawn: the name's first letter on the brand colour.

export type BrandBroker = { name: string; logoUrl: string | null; primaryColor: string | null };
export const PLATFORM_BRAND: BrandBroker = { name: "VyXTrader", logoUrl: null, primaryColor: "#F5A623" };

export async function brandForHost(host: string | null): Promise<BrandBroker> {
  const hostname = (host ?? "").split(":")[0].toLowerCase();
  const root = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];
  const select = { name: true, logoUrl: true, primaryColor: true } as const;
  if (!hostname || hostname === root || hostname === `www.${root}`) return PLATFORM_BRAND;
  const broker = hostname.endsWith(`.${root}`)
    ? await prisma.broker.findUnique({ where: { subdomain: hostname.slice(0, -root.length - 1) }, select })
    : await prisma.broker.findFirst({ where: { customDomain: { in: [hostname, hostname.replace(/^www\./, ""), `www.${hostname.replace(/^www\./, "")}`] } }, select });
  return broker ?? PLATFORM_BRAND;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;

/** One PNG in an .ico container, which every browser and crawler asking for /favicon.ico accepts. */
export function icoFromPng(png: Buffer, size: number): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt8(size >= 256 ? 0 : size, 6);
  head.writeUInt8(size >= 256 ? 0 : size, 7);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}

export function webManifest(b: BrandBroker) {
  const theme = b.primaryColor && HEX.test(b.primaryColor) ? b.primaryColor : "#0B0B0C";
  return {
    name: b.name,
    short_name: b.name.slice(0, 12),
    start_url: "/room",
    display: "standalone",
    background_color: "#0B0B0C",
    theme_color: theme,
    icons: [192, 512].map((s) => ({ src: `/brand-icon/${s}`, sizes: `${s}x${s}`, type: "image/png", purpose: "any" })),
  };
}
