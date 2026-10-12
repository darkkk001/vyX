import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFeedCache, compareVersions, currentFromReleases, originOf, readFeedInfo } from "@/lib/download-feed";
import { GET } from "@/app/(broker)/download/[kind]/route";

const feed = (kind: string) => JSON.parse(readFileSync(new URL(`../public/native-${kind}-updates/futurixglobal/releases.win.json`, import.meta.url), "utf8"));

afterEach(() => {
  clearFeedCache();
  vi.restoreAllMocks();
});

describe("download feed read", () => {
  it("compares versions numerically (1.0.9 < 1.0.64)", () => {
    expect(compareVersions("1.0.64", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.10", "1.0.10")).toBe(0);
  });
  it("reads the highest Full version and the Setup file from the real feeds", () => {
    const t = currentFromReleases(feed("terminal"), "terminal", "futurixglobal")!;
    expect(t.setupFile).toBe("Setup-FuturixTrader.exe");
    expect(t.setupPath).toBe("/native-terminal-updates/futurixglobal/Setup-FuturixTrader.exe");
    expect(compareVersions(t.version, "1.0.64")).toBeGreaterThanOrEqual(0);
    const b = currentFromReleases(feed("backoffice"), "backoffice", "futurixglobal")!;
    expect(b.setupPath).toBe("/native-backoffice-updates/futurixglobal/Setup-FuturixBackoffice.exe");
  });
  it("ignores delta entries and an empty feed", () => {
    expect(currentFromReleases({ Assets: [{ PackageId: "AcmeTraderNative", Version: "2.0.0", Type: "Delta" }] }, "terminal", "acme")).toBeNull();
    expect(currentFromReleases({ Assets: [] }, "terminal", "acme")).toBeNull();
    expect(currentFromReleases(null, "terminal", "acme")).toBeNull();
    const info = currentFromReleases({ Assets: [{ PackageId: "AcmeTraderNative", Version: "2.0.0", Type: "Full" }, { PackageId: "AcmeTraderNative", Version: "10.0.0", Type: "Full" }] }, "terminal", "acme")!;
    expect(info.version).toBe("10.0.0");
    expect(info.setupPath).toBe("/native-terminal-updates/acme/Setup-AcmeTrader.exe");
  });
  it("originOf prefers the forwarded host and uses http only for localhost", () => {
    expect(originOf(new Headers({ host: "a.example.com" }))).toBe("https://a.example.com");
    expect(originOf(new Headers({ host: "x", "x-forwarded-host": "b.example.com" }))).toBe("https://b.example.com");
    expect(originOf(new Headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
  it("readFeedInfo caches and survives a failed re-read", async () => {
    const releases = feed("terminal");
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => releases });
    const a = await readFeedInfo("terminal", "futurixglobal", "https://h.test", f);
    await readFeedInfo("terminal", "futurixglobal", "https://h.test", f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a?.version).toBeTruthy();
    expect(f.mock.calls[0][0]).toBe("https://h.test/native-terminal-updates/futurixglobal/releases.win.json");
  });
});

describe("/download/<app> redirects", () => {
  const call = (kind: string, headers: Record<string, string>) =>
    GET(new Request(`https://www.example.com/download/${kind}`, { headers }), { params: Promise.resolve({ kind }) });
  const stubFeed = (kind: string, slug: string) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(String(url)).toBe(`https://www.example.com/native-${kind}-updates/${slug}/releases.win.json`);
      return { ok: true, json: async () => feed(kind) };
    }));

  it("terminal -> 302 to the broker's own Setup.exe", async () => {
    stubFeed("terminal", "futurixglobal");
    const res = await call("terminal", { host: "www.example.com", "x-broker-slug": "futurixglobal" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://www.example.com/native-terminal-updates/futurixglobal/Setup-FuturixTrader.exe");
  });
  it("backoffice -> 302 to the broker's own Setup.exe", async () => {
    stubFeed("backoffice", "futurixglobal");
    const res = await call("backoffice", { host: "www.example.com", "x-broker-slug": "futurixglobal" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://www.example.com/native-backoffice-updates/futurixglobal/Setup-FuturixBackoffice.exe");
  });
  it("the tenant comes from the host header, not a fixed name", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ Assets: [{ PackageId: "AcmeTraderNative", Version: "3.1.0", Type: "Full" }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("terminal", { host: "www.example.com", "x-broker-slug": "acme" });
    expect(res.headers.get("location")).toBe("https://www.example.com/native-terminal-updates/acme/Setup-AcmeTrader.exe");
  });
  it("404 with no broker or an unknown app; 503 when the feed cannot be read", async () => {
    expect((await call("terminal", { host: "www.example.com" })).status).toBe(404);
    expect((await call("mobile", { host: "www.example.com", "x-broker-slug": "futurixglobal" })).status).toBe(404);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect((await call("terminal", { host: "www.example.com", "x-broker-slug": "nofeed" })).status).toBe(503);
  });
});
