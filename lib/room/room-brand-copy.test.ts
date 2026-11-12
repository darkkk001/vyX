import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWordmark, partsFromSplitText, wordmarkPieces } from "@/lib/room/wordmark";

// Owner 2026-11-12: the broker logo larger in the Room (sign-in panel about 140 px, sidebar 40 px), the sign-in panel
// written as the broker's client portal, and a per-broker wordmark (which part in the accent, capitals or mixed case).
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("wordmark setting", () => {
  it("QoreTrader: Qore plain, Trader in the accent, mixed case", () => {
    const s = parseWordmark({ parts: ["Qore", "Trader"], accent: 1, caps: false }, "QoreTrader");
    expect(s).toEqual({ parts: ["Qore", "Trader"], accent: 1, caps: false });
    expect(wordmarkPieces("QoreTrader", s)).toEqual({ pieces: [{ text: "Qore", accent: false }, { text: "Trader", accent: true }], caps: false });
  });
  it("not set: the look every broker had (first word in the accent, capitals), so Futurix is unchanged", () => {
    expect(wordmarkPieces("Futurix Global", null)).toEqual({ pieces: [{ text: "Futurix", accent: true }, { text: " Global", accent: false }], caps: true });
    expect(wordmarkPieces("TradeNext", null)).toEqual({ pieces: [{ text: "TradeNext", accent: true }], caps: true });
  });
  it("refuses parts that do not spell the name, bad accents and missing caps", () => {
    expect(parseWordmark({ parts: ["Qore", "Trade"], accent: 1, caps: false }, "QoreTrader")).toBeNull();
    expect(parseWordmark({ parts: ["Qore", "Trader"], accent: 2, caps: false }, "QoreTrader")).toBeNull();
    expect(parseWordmark({ parts: ["Qore", "Trader"], accent: 1 }, "QoreTrader")).toBeNull();
    expect(parseWordmark({ parts: ["a", "b", "c", "d"], accent: 0, caps: true }, "abcd")).toBeNull();
    expect(parseWordmark(null, "QoreTrader")).toBeNull();
    expect(parseWordmark({ parts: ["Futurix", " Global"], accent: -1, caps: true }, "Futurix Global")).toEqual({ parts: ["Futurix", " Global"], accent: -1, caps: true });
  });
  it("the Super Admin split field", () => {
    expect(partsFromSplitText("Qore|Trader")).toEqual(["Qore", "Trader"]);
    expect(partsFromSplitText("Futurix| Global")).toEqual(["Futurix", " Global"]);
  });
  it("stored on Broker, migrated, checked and audited by the Super Admin route, drawn by every wordmark", () => {
    expect(read("prisma/schema.prisma")).toMatch(/\n[ \t]+wordmark[ \t]+Json\?\r?\n/);
    expect(read("prisma/migrations/20261112120000_broker_wordmark/migration.sql")).toContain('ALTER TABLE "Broker" ADD COLUMN "wordmark" JSONB;');
    const route = read("app/api/admin/brokers/[id]/route.ts");
    expect(route).toContain("parseWordmark(body.wordmark, existing.name)");
    expect(route).toContain('action: "BROKER_WORDMARK_CHANGED"');
    expect(read("lib/room/context.ts")).toContain("wordmark: parseWordmark(b.wordmark, b.name)");
    expect(read("components/room/AuthBrandPanel.tsx")).toContain("wordmark={broker.wordmark}");
    expect(read("components/room/RoomSidebar.tsx")).toContain("wordmark={wordmark} showName");
    expect(read("app/(broker)/room/room.css")).toContain(".r-auth-brand .r-logo-word.r-wm-mixed, .r-side .r-wordmark.r-wm-mixed { text-transform: none; letter-spacing: 0.4px; }");
  });
});

describe("sign-in panel and forms", () => {
  const panel = read("components/room/AuthBrandPanel.tsx");
  const css = read("app/(broker)/room/room.css");
  it("the client portal copy, the old headline and tagline gone", () => {
    expect(panel).toContain('{eyebrow ? <div className="r-auth-eyebrow">CLIENT PORTAL</div> : null}');
    // QoreTrader's sign-in drops the label (owner 2026-11-12); register, forgot-password and other brokers keep it
    expect(read("app/(broker)/room/login/LoginView.tsx")).toContain('<AuthShell broker={broker} eyebrow={broker.subdomain !== "qoretrader"}>');
    expect(panel).toContain('<div className="r-auth-title">{broker.name} Client Portal</div>');
    expect(panel).toContain('["Open live and demo accounts", "Deposit, withdraw and transfer funds", "Verify your identity", "Track your trading and tier"]');
    expect(panel).not.toMatch(/Trade with|every platform/);
    expect(read("app/(broker)/room/login/LoginForm.tsx")).toContain("<h1>Sign in to your client portal</h1>");
    expect(read("app/(broker)/room/register/RegisterForm.tsx")).toContain(">Open your client portal account</h1>");
    expect(read("app/(broker)/room/forgot-password/RoomForgotForm.tsx")).toContain("<h1>Forgot password?</h1>");
  });
  it("logo about 140 px above the headline, 40 px in the sidebar", () => {
    expect(panel).toContain('<BrokerLogoImg className="r-auth-mark" src={broker.logoUrl} height={140} />');
    expect(css).toContain(".r-auth-mark { height: 140px;");
    expect(css).toContain(".r-side .r-brand img { flex: none; height: 40px; max-height: 40px;");
  });
});
