import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { originOf, readFeedInfo } from "@/lib/download-feed";
import RoomFrame from "@/components/room/RoomFrame";
import RoomBrand from "@/components/room/RoomBrand";
import { parseWordmark } from "@/lib/room/wordmark";

export const dynamic = "force-dynamic";

// The terminal download page of every broker (owner 2026-11-04): the Downloads card with the current version, so the
// installer never starts without context. The button goes to the installer of THIS broker's feed.
export default async function TerminalDownloadPage() {
  const h = await headers();
  const brokerId = h.get("x-broker-id");
  const slug = h.get("x-broker-slug");
  if (!brokerId || !slug) redirect("/broker-not-found");
  const row = await prisma.broker.findUnique({ where: { id: brokerId }, select: { id: true, name: true, subdomain: true, logoUrl: true, primaryColor: true, wordmark: true } });
  if (!row) redirect("/broker-not-found");
  const broker = { ...row, wordmark: parseWordmark(row.wordmark, row.name) };
  const feed = await readFeedInfo("terminal", slug, originOf(h)).catch(() => null);
  return (
    <RoomFrame broker={broker}>
      <main style={{ minHeight: "100vh", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26, padding: 16 }}>
        <div className="r-brand" style={{ padding: 0 }}><RoomBrand name={broker.name} logoUrl={broker.logoUrl} wordmark={broker.wordmark} size={30} /></div>
        <div className="r-card" style={{ width: "100%", maxWidth: 420, boxSizing: "border-box", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontFamily: "var(--r-head)", fontSize: 16.5, fontWeight: 600 }}>Desktop terminal</h1>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", marginTop: 6, lineHeight: 1.6 }}>Full trading workstation: charts, one-click trading, depth, alerts.</div>
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)" }}>Windows 10/11 · 64-bit{feed ? ` · v${feed.version}` : ""}</div>
          {feed ? (
            <>
              <a className="r-btn" href={feed.setupPath} style={{ padding: "11px 0" }}>Download for Windows</a>
              <div className="r-note">If Windows shows a warning, select More info, then Run anyway.</div>
            </>
          ) : <span className="r-note">The installer is being updated. Try again shortly.</span>}
        </div>
      </main>
    </RoomFrame>
  );
}
