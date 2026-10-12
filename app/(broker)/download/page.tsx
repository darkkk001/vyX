import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DOWNLOAD_KINDS, originOf, readFeedInfo, type DownloadKind } from "@/lib/download-feed";

export const dynamic = "force-dynamic";

// Public Downloads page of a broker: two buttons, the current version of each app read from the broker's own feed.
export default async function DownloadPage() {
  const headerList = await headers();
  const brokerId = headerList.get("x-broker-id");
  const slug = headerList.get("x-broker-slug");
  if (!brokerId || !slug) redirect("/broker-not-found");
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { name: true, logoUrl: true } });
  if (!broker) redirect("/broker-not-found");
  const origin = originOf(headerList);
  const kinds: DownloadKind[] = ["terminal", "backoffice"];
  const infos = await Promise.all(kinds.map((k) => readFeedInfo(k, slug, origin)));

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "#0f1115", color: "#e8eaed", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 460, textAlign: "center" }}>
        {broker.logoUrl ? <img src={broker.logoUrl} alt="" style={{ maxHeight: 56, maxWidth: 220, marginBottom: 16 }} /> : null}
        <h1 style={{ fontSize: 26, margin: "0 0 8px" }}>Download {broker.name}</h1>
        <p style={{ margin: "0 0 28px", color: "#9aa0a6" }}>Windows 10/11, installs without admin rights, updates itself.</p>
        {kinds.map((k, i) => (
          <div key={k} style={{ marginBottom: 16 }}>
            <a
              href={`/download/${k}`}
              style={{ display: "block", padding: "14px 18px", borderRadius: 8, background: "var(--brand-primary, #1e8a5f)", color: "#fff", textDecoration: "none", fontWeight: 600, fontSize: 16 }}
            >
              Download {DOWNLOAD_KINDS[k].label}
            </a>
            <div style={{ marginTop: 6, fontSize: 13, color: "#9aa0a6" }}>{infos[i] ? `Version ${infos[i]!.version}` : "Not available right now"}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
