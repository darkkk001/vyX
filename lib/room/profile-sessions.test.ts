import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Owner 2026-11-12: Profile's Active sessions card is about 5 sessions tall; the rest scroll inside it, with a
// scrollbar in the theme's colours, so the page does not grow.
const read = (p: string) => readFileSync(p, "utf8");

describe("Active sessions list", () => {
  it("scrolls inside the card after about 5 sessions", () => {
    expect(read("app/(broker)/room/(shell)/profile/page.tsx")).toContain('<div className="r-sessions" style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>');
    const css = read("app/(broker)/room/room.css");
    expect(css).toContain(".r-sessions { max-height: 296px; overflow-y: auto;");
    // the thumb comes from the theme's muted colour, so it follows light and dark
    expect(css).toContain("scrollbar-color: color-mix(in srgb, var(--r-muted) 45%, transparent) transparent;");
    expect(css).toContain(".r-sessions::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--r-muted) 45%, transparent);");
  });
});
