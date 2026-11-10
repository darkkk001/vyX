import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Account cards, Exness-style (owner 2026-11-10): one card on Dashboard and Accounts; platform + plan chips, #number,
// nickname; no "plan · 1:leverage" text (leverage is in Settings); Trade (accent), Deposit, Withdraw, Transfer, three-dot;
// demo: Trade, Top up, three-dot. The three-dot opens the Accounts Settings drawer, with the rows the owner listed.
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const card = read("components/room/AccountCard.tsx");
const drawer = read("components/room/AccountDrawer.tsx");

describe("account card", () => {
  it("header: QT and plan chips, #number, nickname; no leverage", () => {
    expect(card).toMatch(/r-plat-chip[^>]*>\{PLATFORM\.chip\}<\/span>\s*<span className="r-plan-chip">\{a\.plan\}<\/span>\s*<span className="mono r-acct-no">#\{a\.accountNumber\}<\/span>\s*\{a\.nickname \?/);
    expect(card).not.toContain("a.leverage");
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
