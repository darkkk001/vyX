// Stable download addresses (hotfix 2026-10-08): /download/terminal and /download/backoffice on a broker's own host
// always lead to the CURRENT Setup.exe of that broker's update feed, and /download shows the current version. The feed
// is the same static folder the installed apps update from (public/native-<app>-updates/<broker>/): its
// releases.win.json lists the packages (PackageId + Version) and the installer is always Setup-<PackageId minus
// "Native">.exe, so nothing here is hard-coded to one broker.

export type DownloadKind = "terminal" | "backoffice";

export const DOWNLOAD_KINDS: Record<DownloadKind, { folder: string; label: string }> = {
  terminal: { folder: "native-terminal-updates", label: "Trading terminal" },
  backoffice: { folder: "native-backoffice-updates", label: "Backoffice" },
};

export type FeedInfo = { version: string; setupPath: string; setupFile: string };
export type FeedFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function isDownloadKind(v: string): v is DownloadKind {
  return v === "terminal" || v === "backoffice";
}

/** 1.0.9 < 1.0.64; non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The current version and installer path out of a parsed releases.win.json (null when it lists no package). */
export function currentFromReleases(releases: unknown, kind: DownloadKind, slug: string): FeedInfo | null {
  const assets = (releases as { Assets?: { PackageId?: unknown; Version?: unknown; Type?: unknown }[] } | null)?.Assets;
  if (!Array.isArray(assets)) return null;
  let best: { id: string; version: string } | null = null;
  for (const a of assets) {
    if (typeof a?.PackageId !== "string" || typeof a?.Version !== "string") continue;
    if (a.Type !== undefined && a.Type !== "Full") continue;
    if (!best || compareVersions(a.Version, best.version) > 0) best = { id: a.PackageId, version: a.Version };
  }
  if (!best) return null;
  const setupFile = `Setup-${best.id.replace(/Native$/, "")}.exe`;
  return { version: best.version, setupFile, setupPath: `/${DOWNLOAD_KINDS[kind].folder}/${encodeURIComponent(slug)}/${setupFile}` };
}

const cache = new Map<string, { at: number; info: FeedInfo | null }>();
const TTL_MS = 60_000;

/** Reads the broker's feed over HTTP from its own origin; cached for a minute, null when it cannot be read. */
export async function readFeedInfo(kind: DownloadKind, slug: string, origin: string, fetcher: FeedFetch = (u) => fetch(u, { cache: "no-store" })): Promise<FeedInfo | null> {
  const key = `${origin}|${kind}|${slug}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;
  let info: FeedInfo | null = null;
  try {
    const res = await fetcher(`${origin}/${DOWNLOAD_KINDS[kind].folder}/${encodeURIComponent(slug)}/releases.win.json`);
    if (res.ok) info = currentFromReleases(await res.json(), kind, slug);
  } catch {
    info = null;
  }
  if (info) cache.set(key, { at: Date.now(), info });
  else if (hit?.info) return hit.info; // a failed re-read keeps serving the last good answer
  return info;
}

export function clearFeedCache() {
  cache.clear();
}

/** https://<host> for the request (the host the visitor typed; the feed lives on it). */
export function originOf(h: { get(name: string): string | null }): string {
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}
