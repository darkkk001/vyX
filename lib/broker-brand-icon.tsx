import "server-only";
import { ImageResponse } from "next/og";
import { HEX, type BrandBroker } from "@/lib/broker-brand";

// The drawing half of lib/broker-brand.ts.

function letterIcon(b: BrandBroker, size: number) {
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: b.primaryColor && HEX.test(b.primaryColor) ? b.primaryColor : "#141417", color: "#FFFFFF", fontSize: size * 0.62, fontWeight: 700 }}>
      {(b.name.trim()[0] ?? "V").toUpperCase()}
    </div>,
    { width: size, height: size }
  );
}

/** The tenant's icon as a square PNG. */
export async function brandIconPng(b: BrandBroker, size: number, origin: string): Promise<Buffer> {
  if (b.logoUrl) {
    try {
      const src = /^(https?:|data:)/.test(b.logoUrl) ? b.logoUrl : new URL(b.logoUrl, origin).toString();
      const res = new ImageResponse(
        // eslint-disable-next-line @next/next/no-img-element
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "transparent" }}><img src={src} alt="" width={size} height={size} style={{ objectFit: "contain" }} /></div>,
        { width: size, height: size }
      );
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error("[brand-icon] logo could not be drawn, using the letter", err);
    }
  }
  return Buffer.from(await letterIcon(b, size).arrayBuffer());
}
