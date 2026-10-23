import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountHeaderLines, accountPickerLabel, planOf } from "./account-header";

const webTrader = readFileSync(join(process.cwd(), "components", "webtrader", "WebTrader.tsx"), "utf8");
const header = readFileSync(join(process.cwd(), "components", "webtrader", "AccountHeader.tsx"), "utf8");
const lines = (l: { kind: string; text: string }[]) => l.map((x) => `${x.kind}:${x.text}`);

describe("account header and picker (WebTrader)", () => {
  it("the header is plan, client name, account number and nothing else", () => {
    expect(lines(accountHeaderLines("Pro", "Amir Khan", "50005696")))
      .toEqual(["plan:Pro", "name:Amir Khan", "number:50005696"]);
  });

  it("no accountPlan sent: no plan line, nothing in its place", () => {
    expect(lines(accountHeaderLines(undefined, "Amir Khan", "50005696")))
      .toEqual(["name:Amir Khan", "number:50005696"]);
  });

  it("the picker reads Plan · Name · Number, missing parts left out", () => {
    expect(accountPickerLabel("Pro", "Amir Khan", "50005696")).toBe("Pro · Amir Khan · 50005696");
    expect(accountPickerLabel(undefined, "Amir Khan", "50005696")).toBe("Amir Khan · 50005696");
    expect(accountPickerLabel("", "", "50005696")).toBe("50005696");
    expect(planOf({ name: "Zero" })).toBe("Zero");
    expect(planOf(null)).toBe("");
  });

  it("the header component renders exactly those lines", () => {
    expect(header).toContain("accountHeaderLines(plan, name, number).map(");
    expect(header.match(/<span/g)?.length).toBe(2);   // the wrapper and one span per line, nothing else
  });

  it("WebTrader builds the header and the picker from these, and never shows the backend group", () => {
    expect(webTrader).toContain("<AccountHeader plan={account.accountPlan}");
    expect(webTrader).toContain("accountPickerLabel(la.accountPlan,");
    expect(webTrader).not.toMatch(/groupName|group\.name/);
    // the switcher no longer shows mode badges or balances next to the accounts
    const switcher = webTrader.slice(webTrader.indexOf('<div className="account-switcher"'), webTrader.indexOf("Change password"));
    expect(switcher).not.toContain("acc-badge");
    expect(switcher).not.toContain("acc-option-balance");
    expect(switcher).not.toContain("mode-toggle-label");
  });
});
