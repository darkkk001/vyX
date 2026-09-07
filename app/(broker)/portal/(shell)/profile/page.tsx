import { getClientSession } from "@/lib/client-auth";
import { prisma } from "@/lib/prisma";
import styles from "@/components/portal/PortalShell.module.css";

// Read-only for now -- the data shown here is real (this client's own
// row), only editing (change password, eventually 2FA) is deferred.
export default async function PortalProfilePage() {
  const session = await getClientSession();
  const client = await prisma.client.findUnique({
    where: { id: session!.clientId },
    select: { fullName: true, email: true, country: true, phone: true, emailVerifiedAt: true, createdAt: true },
  });

  const rows: { label: string; value: string }[] = [
    { label: "Full name", value: client?.fullName ?? "-" },
    { label: "Email", value: client?.email ?? "-" },
    { label: "Email verified", value: client?.emailVerifiedAt ? new Date(client.emailVerifiedAt).toLocaleDateString() : "-" },
    { label: "Country", value: client?.country ?? "Not set" },
    { label: "Phone", value: client?.phone ?? "Not set" },
    { label: "Member since", value: client?.createdAt ? new Date(client.createdAt).toLocaleDateString() : "-" },
  ];

  return (
    <div className={styles.panel}>
      <h2 className={styles.panelTitle} style={{ marginBottom: 18 }}>
        Your details
        <span className={styles.comingSoon}>Editing coming soon</span>
      </h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px 32px" }}>
        {rows.map((row) => (
          <div key={row.label}>
            <div style={{ fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: ".04em", fontWeight: 600, marginBottom: 4 }}>{row.label}</div>
            <div style={{ fontSize: 13.5 }}>{row.value}</div>
          </div>
        ))}
      </div>
      <p className={styles.panelText} style={{ color: "var(--text-3)", marginTop: 22, fontSize: 12 }}>
        Changing your password and security settings arrives in Stage 4, extracted from WebTrader&apos;s own Settings panel.
      </p>
    </div>
  );
}
