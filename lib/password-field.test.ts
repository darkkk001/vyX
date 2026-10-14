import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { capsLockOn, passwordEyeLabel } from "./password-field";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("password field helpers", () => {
  it("Caps Lock is on exactly when the keyboard event says so", () => {
    expect(capsLockOn((key) => key === "CapsLock")).toBe(true);
    expect(capsLockOn(() => false)).toBe(false);
    expect(capsLockOn(() => {
      throw new Error("not a keyboard event");
    })).toBe(false);
  });

  it("the eye names what a click does", () => {
    expect(passwordEyeLabel(false)).toBe("Show password");
    expect(passwordEyeLabel(true)).toBe("Hide password");
  });
});

// (This repo's test runner does not transform JSX, so the component's structure is checked on its source.)
describe("PasswordField", () => {
  const src = read("components/PasswordField.tsx");

  it("is hidden by default and the eye switches it", () => {
    expect(src).toContain("useState(false)");
    expect(src).toContain('type={visible ? "text" : "password"}');
    expect(src).toContain("passwordEyeLabel(visible)");
    expect(src).toContain("setVisible((v) => !v)");
  });

  it("has the eye INSIDE the field at the right edge, and reserves room for it in the input", () => {
    expect(src).toMatch(/position: "relative"/);
    expect(src).toMatch(/position: "absolute"/);
    expect(src).toMatch(/right: 6/);
    expect(src).toMatch(/paddingRight: 38/);
  });

  it("shows a Caps Lock line under the field only while Caps Lock is on, and clears it on blur", () => {
    expect(src).toContain("{caps ? (");
    expect(src).toContain("Caps Lock is on");
    expect(src).toContain("setCaps(capsLockOn((key) => event.getModifierState(key)))");
    expect(src).toContain("setCaps(false)");
    expect(src.indexOf("</button>")).toBeLessThan(src.lastIndexOf("Caps Lock is on"));   // under the input row, not inside it
  });
});

describe("every password input of the WebTrader and the client sign-in uses it", () => {
  it("the WebTrader sign-in, its password dialogs, and the portal sign-in have no raw password input", () => {
    for (const rel of [
      "app/(broker)/trade/login/TradeLoginForm.tsx",
      "components/webtrader/WebTrader.tsx",
      "app/(broker)/portal/login/LoginForm.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/type=["']password["']/);
      expect(src, rel).toContain("components/PasswordField");
      expect(src, rel).toContain("<PasswordField");
    }
  });

  it("the WebTrader has five password fields (change password x3, disable 2FA, account switch) and its sign-in one, all through the component", () => {
    const wt = read("components/webtrader/WebTrader.tsx");
    expect((wt.match(/<PasswordField/g) ?? []).length).toBe(5);
    const login = read("app/(broker)/trade/login/TradeLoginForm.tsx");
    expect((login.match(/<PasswordField/g) ?? []).length).toBe(1);
  });
});
