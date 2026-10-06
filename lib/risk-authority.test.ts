import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getRiskAuthority, isRustAuthoritative, riskOwnerOf } from "./risk-authority";

describe("risk authority helper", () => {
  it("returns WEB and RUST as stored", () => {
    expect(getRiskAuthority({ riskAuthority: "WEB" })).toBe("WEB");
    expect(getRiskAuthority({ riskAuthority: "RUST" })).toBe("RUST");
    expect(isRustAuthoritative({ riskAuthority: "RUST" })).toBe(true);
    expect(isRustAuthoritative({ riskAuthority: "WEB" })).toBe(false);
  });

  it("falls back to WEB when the value is missing or unknown", () => {
    expect(getRiskAuthority(null)).toBe("WEB");
    expect(getRiskAuthority(undefined)).toBe("WEB");
    expect(getRiskAuthority({})).toBe("WEB");
    expect(getRiskAuthority({ riskAuthority: null })).toBe("WEB");
    expect(getRiskAuthority({ riskAuthority: "rust" })).toBe("WEB");
    expect(getRiskAuthority({ riskAuthority: "SOMETHING_NEW" })).toBe("WEB");
    expect(isRustAuthoritative(null)).toBe(false);
  });

  it("scopes RUST to demo accounts while demo-only, and defaults to demo-only", () => {
    const rust = { riskAuthority: "RUST", riskAuthorityDemoOnly: true };
    expect(riskOwnerOf(rust, "DEMO")).toBe("RUST");
    expect(riskOwnerOf(rust, "LIVE")).toBe("WEB");
    expect(riskOwnerOf({ riskAuthority: "RUST" }, "LIVE")).toBe("WEB");
    expect(riskOwnerOf({ riskAuthority: "RUST", riskAuthorityDemoOnly: false }, "LIVE")).toBe("RUST");
    expect(riskOwnerOf({ riskAuthority: "WEB", riskAuthorityDemoOnly: false }, "DEMO")).toBe("WEB");
    expect(riskOwnerOf(null, "DEMO")).toBe("WEB");
  });
});

describe("Broker.riskAuthority column", () => {
  it("defaults to WEB and demo-only on insert, and accepts RUST", async () => {
    const db = new PrismaClient();
    const sub = `ra${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    try {
      const b = await db.broker.create({ data: { name: sub, subdomain: sub } });
      expect(b.riskAuthority).toBe("WEB");
      expect(b.riskAuthorityDemoOnly).toBe(true);
      expect(getRiskAuthority(b)).toBe("WEB");
      const flipped = await db.broker.update({ where: { id: b.id }, data: { riskAuthority: "RUST" } });
      expect(getRiskAuthority(flipped)).toBe("RUST");
      await db.broker.delete({ where: { id: b.id } });
    } finally {
      await db.$disconnect();
    }
  });
});
