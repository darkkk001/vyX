"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { FormField } from "@/components/ui/FormField";
import { Modal, ModalSection, ModalRow2, ModalActions } from "@/components/ui/Modal";
import { Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, TableEmptyState } from "@/components/ui/Table";
import EngineSwitch from "./EngineSwitch";

export type BrokerRow = {
  id: string;
  name: string;
  subdomain: string;
  customDomain: string | null;
  tier: "STANDARD" | "WHITE_LABEL";
  status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "DISABLED";
  executionEngine: "LEGACY" | "RUST";
  trialEndsAt: string | null;
  createdAt: string;
  hasSsoSecret: boolean;
};

type AdminOption = { id: string; email: string; role: string; status: string; brokerId: string | null };

const statusTone = { TRIAL: "warning", ACTIVE: "success", SUSPENDED: "danger", DISABLED: "neutral" } as const;

export default function BrokersManager({ initialRows }: { initialRows: BrokerRow[] }) {
  const router = useRouter();

  // --- Register broker modal ---
  const [registerOpen, setRegisterOpen] = useState(false);
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [tier, setTier] = useState<"STANDARD" | "WHITE_LABEL">("STANDARD");
  const [primaryColor, setPrimaryColor] = useState("#1e8a5f");
  const [logoUrl, setLogoUrl] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  function launchRegisterModal() {
    setName("");
    setSubdomain("");
    setCustomDomain("");
    setTier("STANDARD");
    setPrimaryColor("#1e8a5f");
    setLogoUrl("");
    setAdminEmail("");
    setAdminPassword("");
    setRegisterError(null);
    setRegisterOpen(true);
  }

  async function submitRegister() {
    setRegistering(true);
    setRegisterError(null);
    const response = await fetch("/api/admin/brokers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        subdomain,
        customDomain: customDomain || null,
        tier,
        primaryColor,
        logoUrl: logoUrl || null,
        adminEmail: adminEmail || undefined,
        adminPassword: adminPassword || undefined,
      }),
    });
    setRegistering(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setRegisterError(body.error ?? "failed to create broker");
      return;
    }
    setRegisterOpen(false);
    router.refresh();
  }

  // --- Tenant detail modal ---
  const [detailTarget, setDetailTarget] = useState<BrokerRow | null>(null);
  const [detailAdmins, setDetailAdmins] = useState<AdminOption[] | null>(null);
  const [newAdminEmail, setNewAdminEmail] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // --- WebTrader SSO secret (Tenant detail modal) ---
  // Only ever held in state right after generation -- the API never
  // returns the value again after this response, so once the modal
  // closes or another action runs, it's gone from the UI too.
  const [revealedSsoSecret, setRevealedSsoSecret] = useState<string | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);

  async function openDetail(row: BrokerRow) {
    setDetailTarget(row);
    setDetailAdmins(null);
    setNewAdminEmail("");
    setDetailError(null);
    setRevealedSsoSecret(null);
    setSsoError(null);
    const response = await fetch("/api/admin/admins");
    if (response.ok) {
      const all = (await response.json()) as AdminOption[];
      setDetailAdmins(all.filter((a) => a.brokerId === row.id));
    } else {
      setDetailAdmins([]);
    }
  }

  async function setStatus(status: BrokerRow["status"]) {
    if (!detailTarget) return;
    setDetailBusy(true);
    setDetailError(null);
    const response = await fetch(`/api/admin/brokers/${detailTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setDetailBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setDetailError(body.error ?? "update failed");
      return;
    }
    setDetailTarget((prev) => (prev ? { ...prev, status } : prev));
    router.refresh();
  }

  async function assignAdmin() {
    if (!detailTarget || !newAdminEmail.trim()) return;
    setDetailBusy(true);
    setDetailError(null);
    const response = await fetch("/api/admin/admins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brokerId: detailTarget.id, email: newAdminEmail.trim(), password: "ChangeMe123!", role: "BROKER_ADMIN" }),
    });
    setDetailBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setDetailError(body.error ?? "failed to assign admin");
      return;
    }
    const created = await response.json();
    setDetailAdmins((prev) => [...(prev ?? []), { id: created.id, email: created.email, role: created.role, status: "ACTIVE", brokerId: detailTarget.id }]);
    setNewAdminEmail("");
    router.refresh();
  }

  async function removeAdmin(admin: AdminOption) {
    setDetailBusy(true);
    setDetailError(null);
    const response = await fetch(`/api/admin/admins/${admin.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "DISABLED" }),
    });
    setDetailBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setDetailError(body.error ?? "failed to remove admin");
      return;
    }
    setDetailAdmins((prev) => prev?.map((a) => (a.id === admin.id ? { ...a, status: "DISABLED" } : a)) ?? null);
    router.refresh();
  }

  async function generateSsoSecret() {
    if (!detailTarget) return;
    setSsoBusy(true);
    setSsoError(null);
    const response = await fetch(`/api/admin/brokers/${detailTarget.id}/sso-secret`, { method: "POST" });
    setSsoBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setSsoError(body.error ?? "failed to generate secret");
      return;
    }
    const { ssoSecret } = (await response.json()) as { ssoSecret: string };
    setRevealedSsoSecret(ssoSecret);
    setDetailTarget((prev) => (prev ? { ...prev, hasSsoSecret: true } : prev));
    router.refresh();
  }

  async function revokeSsoSecret() {
    if (!detailTarget) return;
    setSsoBusy(true);
    setSsoError(null);
    const response = await fetch(`/api/admin/brokers/${detailTarget.id}/sso-secret`, { method: "DELETE" });
    setSsoBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setSsoError(body.error ?? "failed to revoke secret");
      return;
    }
    setRevealedSsoSecret(null);
    setDetailTarget((prev) => (prev ? { ...prev, hasSsoSecret: false } : prev));
    router.refresh();
  }

  return (
    <>
      <Table title="Brokers" action={<Button variant="primary" onClick={launchRegisterModal}>+ Register new broker</Button>}>
        <TableHead>
          <TableHeaderCell>Broker</TableHeaderCell>
          <TableHeaderCell>Domain</TableHeaderCell>
          <TableHeaderCell>Plan</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Engine</TableHeaderCell>
          <TableHeaderCell>Created</TableHeaderCell>
          <TableHeaderCell />
        </TableHead>
        <TableBody>
          {initialRows.length === 0 ? (
            <TableEmptyState colSpan={7}>No brokers yet.</TableEmptyState>
          ) : (
            initialRows.map((broker) => (
              <TableRow key={broker.id}>
                <TableCell primary>
                  {broker.name}
                  <div className="text-xs font-normal text-[var(--text-3)]">{broker.subdomain}.vyxtrader.com</div>
                </TableCell>
                <TableCell mono className="text-[var(--text-3)]">
                  {broker.customDomain ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge tone={broker.tier === "WHITE_LABEL" ? "accent" : "neutral"}>
                    {broker.tier === "WHITE_LABEL" ? "White-Label" : "Standard"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge tone={statusTone[broker.status]}>{broker.status}</Badge>
                </TableCell>
                <TableCell>
                  <EngineSwitch brokerId={broker.id} initialEngine={broker.executionEngine} />
                </TableCell>
                <TableCell className="text-xs text-[var(--text-3)]">{broker.createdAt}</TableCell>
                <TableCell>
                  <button
                    type="button"
                    title="Manage"
                    onClick={() => openDetail(broker)}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-3)] text-[var(--text-2)] hover:text-[var(--text-1)]"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <Modal open={registerOpen} onClose={() => setRegisterOpen(false)} title="Register new broker" wide>
        <ModalSection label="Company details">
          <ModalRow2>
            <FormField label="Broker name">
              <Input placeholder="AcmeFX" value={name} onChange={(e) => setName(e.target.value)} required />
            </FormField>
            <FormField label="Subdomain">
              <Input placeholder="acmefx" value={subdomain} onChange={(e) => setSubdomain(e.target.value)} required />
            </FormField>
          </ModalRow2>
          <div className="mt-2.5">
            <FormField label="Custom domain (optional)">
              <Input placeholder="trade.acmefx.com" mono value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} />
            </FormField>
          </div>
        </ModalSection>

        <ModalSection label="Branding">
          <ModalRow2>
            <FormField label="Primary brand color">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                title="Primary brand color"
                className="h-9 w-16 rounded border border-[var(--border)] bg-[var(--bg-2)]"
              />
            </FormField>
            <FormField label="Logo URL (optional)">
              <Input placeholder="https://..." value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
            </FormField>
          </ModalRow2>
        </ModalSection>

        <ModalSection label="Plan">
          <Select value={tier} onChange={(e) => setTier(e.target.value as "STANDARD" | "WHITE_LABEL")}>
            <option value="STANDARD">Standard ($500/mo) — logo only, no CRM access</option>
            <option value="WHITE_LABEL">White-Label ($800/mo) — full branding + backoffice/CRM access</option>
          </Select>
        </ModalSection>

        <ModalSection label="First Broker Admin account (optional)">
          <ModalRow2>
            <FormField label="Admin email">
              <Input type="email" placeholder="admin@acmefx.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </FormField>
            <FormField label="Initial password (min 8 chars)">
              <Input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} />
            </FormField>
          </ModalRow2>
          <p className="mt-1.5 text-xs text-[var(--text-3)]">Leave both blank to create the broker without an admin — assign one later from Tenant Detail.</p>
        </ModalSection>

        {registerError ? <p className="mb-2 text-sm text-[var(--sell)]">{registerError}</p> : null}
        <ModalActions>
          <Button variant="ghost" onClick={() => setRegisterOpen(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={registering || !name || !subdomain} onClick={submitRegister}>
            {registering ? "Registering..." : "Register broker"}
          </Button>
        </ModalActions>
      </Modal>

      <Modal open={detailTarget !== null} onClose={() => setDetailTarget(null)} title={detailTarget ? `${detailTarget.name} — manage` : ""} wide>
        {detailTarget ? (
          <div className="flex flex-col gap-1">
            <ModalSection label="Assigned admins">
              {detailAdmins === null ? (
                <p className="text-xs text-[var(--text-3)]">Loading…</p>
              ) : detailAdmins.length === 0 ? (
                <p className="text-xs text-[var(--text-3)]">No admins assigned yet.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {detailAdmins.map((a) => (
                    <div key={a.id} className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2">
                      <div>
                        <p className="text-xs font-medium text-[var(--text-1)]">{a.email}</p>
                        <p className="text-[10px] text-[var(--text-3)]">
                          {a.role} · {a.status}
                        </p>
                      </div>
                      {a.status === "ACTIVE" ? (
                        <Button size="sm" variant="ghost" disabled={detailBusy} onClick={() => removeAdmin(a)}>
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex gap-2">
                <Input placeholder="email@broker.com" value={newAdminEmail} onChange={(e) => setNewAdminEmail(e.target.value)} className="flex-1" />
                <Button size="sm" variant="primary" disabled={detailBusy || !newAdminEmail.trim()} onClick={assignAdmin}>
                  Assign
                </Button>
              </div>
              <p className="mt-1.5 text-[10px] text-[var(--text-3)]">New admins get a temporary password (ChangeMe123!) — same as the Manager team-invite flow.</p>
            </ModalSection>

            <ModalSection label="WebTrader SSO">
              <p className="mb-2 text-xs text-[var(--text-3)]">
                Lets this broker&apos;s own portal hand off already-authenticated traders straight into WebTrader,
                skipping the login form. Shown once at generation time — store it on the broker&apos;s side immediately.
              </p>
              {revealedSsoSecret ? (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--accent)] bg-[var(--bg-2)] px-3 py-2">
                  <code className="select-all break-all text-xs text-[var(--text-1)]">{revealedSsoSecret}</code>
                </div>
              ) : detailTarget.hasSsoSecret ? (
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone="success">Secret set</Badge>
                  <span className="text-xs text-[var(--text-3)]">Value hidden — rotate to issue a new one.</span>
                </div>
              ) : (
                <div className="mb-2">
                  <Badge tone="neutral">No secret yet</Badge>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={ssoBusy} onClick={generateSsoSecret}>
                  {ssoBusy ? "Working..." : detailTarget.hasSsoSecret ? "Rotate secret" : "Generate secret"}
                </Button>
                {detailTarget.hasSsoSecret ? (
                  <Button size="sm" variant="danger" disabled={ssoBusy} onClick={revokeSsoSecret}>
                    Revoke
                  </Button>
                ) : null}
              </div>
              {ssoError ? <p className="mt-1.5 text-sm text-[var(--sell)]">{ssoError}</p> : null}
            </ModalSection>

            <ModalSection label="Tenant lifecycle">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="success" disabled={detailBusy || detailTarget.status === "ACTIVE"} onClick={() => setStatus("ACTIVE")}>
                  Set active
                </Button>
                <Button size="sm" variant="ghost" disabled={detailBusy || detailTarget.status === "TRIAL"} onClick={() => setStatus("TRIAL")}>
                  Set trial
                </Button>
                <Button size="sm" variant="danger" disabled={detailBusy || detailTarget.status === "SUSPENDED"} onClick={() => setStatus("SUSPENDED")}>
                  Suspend
                </Button>
                <Button size="sm" variant="danger" disabled={detailBusy || detailTarget.status === "DISABLED"} onClick={() => setStatus("DISABLED")}>
                  Disable
                </Button>
              </div>
            </ModalSection>

            {detailError ? <p className="text-sm text-[var(--sell)]">{detailError}</p> : null}
            <ModalActions>
              <Button variant="ghost" onClick={() => setDetailTarget(null)}>
                Close
              </Button>
            </ModalActions>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
