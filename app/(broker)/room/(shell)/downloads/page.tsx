import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { readFeedInfo, originOf } from "@/lib/download-feed";
import RoomHeader from "@/components/room/RoomHeader";
import SignInCard from "./SignInCard";

// Artboard "Downloads": desktop terminal (current version from the broker's update feed), WebTrader, mobile, and the
// sign-in details of the picked account. Store buttons show only when the broker has set its own app links.
export default async function RoomDownloads() {
  const h = await headers();
  const brokerId = h.get("x-broker-id");
  const slug = h.get("x-broker-slug");
  const [feed, broker] = await Promise.all([
    slug ? readFeedInfo("terminal", slug, originOf(h)).catch(() => null) : null,
    brokerId ? prisma.broker.findUnique({ where: { id: brokerId }, select: { androidAppUrl: true, iosAppUrl: true } }) : null,
  ]);
  const cardStyle = { padding: 24, display: "flex", flexDirection: "column", gap: 16 } as const;
  const title = { fontFamily: "var(--r-head)", fontSize: 16.5, fontWeight: 600 } as const;
  const text = { fontSize: 12.5, color: "var(--r-text-2)", marginTop: 6, lineHeight: 1.6 } as const;
  const meta = { fontSize: 11.5, color: "var(--r-muted)" } as const;
  return (
    <>
      <RoomHeader title="Downloads" />
      <div className="r-body" style={{ gap: 22 }}>
        <div style={{ fontSize: 13.5, color: "var(--r-text-2)", maxWidth: 640, lineHeight: 1.6 }}>Sign in on any platform with your account number and password. Live prices and positions stay in sync everywhere.</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          <div className="r-card" style={cardStyle}>
            <div>
              <div style={title}>Desktop terminal</div>
              <div style={text}>Full trading workstation: charts, one-click trading, depth, alerts.</div>
            </div>
            <div className="mono" style={meta}>Windows 10/11 · 64-bit{feed ? ` · v${feed.version}` : ""}</div>
            {feed
              ? /* the download page: a full page load, never a client-side navigation */
                // eslint-disable-next-line @next/next/no-html-link-for-pages
                <a className="r-btn" href="/download/terminal" style={{ padding: "11px 0", marginTop: "auto" }}>Download for Windows</a>
              : <span className="r-note" style={{ marginTop: "auto" }}>The installer is being updated. Try again shortly.</span>}
          </div>
          <div className="r-card" style={cardStyle}>
            <div>
              <div style={title}>WebTrader</div>
              <div style={text}>Trade from any browser. Nothing to install: same account, same prices.</div>
            </div>
            <div className="mono" style={meta}>Chrome · Edge · Safari · Firefox</div>
            <a href="/trade" target="_blank" rel="noopener" style={{ marginTop: "auto", border: "1px solid var(--r-accent)", borderRadius: 6, color: "var(--r-gold-text)", fontSize: 13, fontWeight: 600, padding: "11px 0", textAlign: "center" }}>Open WebTrader</a>
          </div>
          <div className="r-card" style={cardStyle}>
            <div>
              <div style={title}>Mobile app</div>
              <div style={text}>Positions, orders and alerts on the move. Sign in with the same account.</div>
            </div>
            <div className="mono" style={meta}>{broker?.androidAppUrl || broker?.iosAppUrl ? "Android 10+ · iOS 16+" : "Any phone browser"}</div>
            <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
              {broker?.androidAppUrl ? <a className="r-btn-ghost" style={{ flex: 1, fontSize: 12.5, padding: "11px 0" }} href={broker.androidAppUrl} target="_blank" rel="noopener">Android</a> : null}
              {broker?.iosAppUrl ? <a className="r-btn-ghost" style={{ flex: 1, fontSize: 12.5, padding: "11px 0" }} href={broker.iosAppUrl} target="_blank" rel="noopener">iOS</a> : null}
              {!broker?.androidAppUrl && !broker?.iosAppUrl ? <a className="r-btn-ghost" style={{ flex: 1, fontSize: 12.5, padding: "11px 0" }} href="/trade">Open on your phone</a> : null}
            </div>
          </div>
        </div>
        <SignInCard />
      </div>
    </>
  );
}
