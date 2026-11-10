import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { platformBrand } from "@/lib/room/platform-brand";

// Account cards, Exness-style (owner 2026-11-10): one card on Dashboard and Accounts; platform + plan chips, #number,
// nickname; no "plan · 1:leverage" text (leverage is in Settings); Trade (accent), Deposit, Withdraw, Transfer, three-dot;
// demo: Trade, Top up, three-dot. The three-dot opens the Accounts Settings drawer, with the rows the owner listed.
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const card = read("components/room/AccountCard.tsx");
const drawer = read("components/room/AccountDrawer.tsx");

describe("account card", () => {
  it("header: the broker's short brand and plan chips, #number, nickname, a pending leverage chip; no leverage text", () => {
    expect(card).toMatch(/r-plat-chip" title=\{platform\.name\}>\{platform\.short\}<\/span>[^\n]*\n\s*<span className="r-plan-chip">\{a\.plan\}<\/span>\s*<span className="mono r-acct-no">#\{a\.accountNumber\}<\/span>\s*\{a\.nickname \?[^\n]*\n\s*\{pending \? <span className="r-chip-pending"[^>]*>1:\{pending\} pending<\/span>/);
    expect(card).not.toContain("a.leverage");
    for (const p of ["app/(broker)/room/(shell)/page.tsx", "app/(broker)/room/(shell)/accounts/page.tsx"]) expect(read(p), p).toContain("pending={levOf(a.id)?.pending?.to ?? null}");
    expect(drawer).toContain("is pending approval.");
  });
  it("the platform is the tenant's brand (owner 2026-11-10), never the technology's name", () => {
    expect(platformBrand("Futurix Global")).toEqual({ name: "Futurix Global", short: "Futurix" });
    expect(platformBrand("TradeNext")).toEqual({ name: "TradeNext", short: "TradeNext" });
    expect(platformBrand("  Futurix   Global ")).toEqual({ name: "Futurix Global", short: "Futurix" });
    expect(read("app/api/room/overview/route.ts")).toContain("platform: platformBrand(session.broker.name),");
    expect(drawer).toContain('<Copy label="Platform" value={platform.name} />');
    for (const s of [card, drawer]) expect(s).not.toMatch(/QoreTrader|"QT"/);
  });
  it("Trade accent first, then Deposit, Withdraw, Transfer (live) or Top up (demo), then the three-dot", () => {
    const order = ['className="r-btn r-btn-sm"', ">Deposit<", ">Withdraw<", ">Transfer<", "<TopUpButton", "r-acct-more"].map((s) => card.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
  it("Dashboard and Accounts use the card and the same drawer", () => {
    for (const p of ["app/(broker)/room/(shell)/page.tsx", "app/(broker)/room/(shell)/accounts/page.tsx"]) {
      const s = read(p);
      expect(s, p).toContain("<AccountCard key={a.id} a={a}");
      expect(s, p).toContain("onSettings={() => setDrawerId(a.id)}");
      expect(s, p).toContain("<AccountDrawer key={drawer.id} account={drawer} lev={levOf(drawer.id)}");
      expect(s, p).not.toMatch(/\{a\.plan\} · 1:\{a\.leverage\}/);
    }
  });
  it("drawer rows in the owner's order, copy icons on Platform, Server and Login, Archive and Transfer at the bottom", () => {
    const rows = ['label="Platform"', 'label="Server"', 'label="Login"', 'label="Plan"', 'label="Trading password"', 'label="Leverage"', 'label="Read-only access"', 'label="Nickname (optional)"', 'label="Statements"', ">Archive<", ">Transfer<"].map((s) => drawer.indexOf(s));
    expect(rows.every((i) => i > 0)).toBe(true);
    expect([...rows].sort((x, y) => x - y)).toEqual(rows);
    expect(drawer).toContain('className="r-icon-btn r-copy-btn"');
    expect(drawer).toMatch(/\{account\.plan\} account\s*<span className=\{`r-mode/);
  });
});
