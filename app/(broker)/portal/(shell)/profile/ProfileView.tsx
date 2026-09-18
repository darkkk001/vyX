"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "@/components/portal/PortalShell.module.css";

type ClientProfile = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  country: string | null;
  dateOfBirth: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
};

const KYC_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  APPROVED: { label: "Approved", color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  PENDING: { label: "Pending review", color: "var(--text-2)", bg: "var(--bg-2)" },
  REJECTED: { label: "Rejected", color: "var(--sell, #EA3943)", bg: "var(--sell-bg, #2A0F11)" },
};

const cancelBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0 16px",
  color: "var(--text-2)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12.5,
};

// Profile tab (Stage 8) -- a real CRM-style profile instead of the
// previous flat details list. Personal Info and Password are genuinely
// editable (PATCH /api/portal/me, POST /api/portal/change-password);
// KYC Status and Verification read already-real data. Two-factor and
// active sessions have no backing data model for Client yet (unlike
// AdminUser/Account, which both already have this) -- shown honestly as
// not-yet-available rather than a fake toggle that does nothing.
export default function ProfileView({ initialClient, initialKycStatus }: { initialClient: ClientProfile; initialKycStatus: string | null }) {
  const [client, setClient] = useState(initialClient);

  const [editingPersonal, setEditingPersonal] = useState(false);
  const [fullName, setFullName] = useState(client.fullName);
  const [phone, setPhone] = useState(client.phone ?? "");
  const [country, setCountry] = useState(client.country ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(client.dateOfBirth ? client.dateOfBirth.slice(0, 10) : "");
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [personalSaving, setPersonalSaving] = useState(false);

  function cancelPersonal() {
    setFullName(client.fullName);
    setPhone(client.phone ?? "");
    setCountry(client.country ?? "");
    setDateOfBirth(client.dateOfBirth ? client.dateOfBirth.slice(0, 10) : "");
    setPersonalError(null);
    setEditingPersonal(false);
  }

  async function savePersonal(event: React.FormEvent) {
    event.preventDefault();
    setPersonalSaving(true);
    setPersonalError(null);
    const response = await fetch("/api/portal/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, phone, country, dateOfBirth: dateOfBirth || null }),
    });
    const body = await response.json().catch(() => ({}));
    setPersonalSaving(false);
    if (!response.ok) {
      setPersonalError(body.error ?? "failed to save");
      return;
    }
    setClient(body);
    setEditingPersonal(false);
  }

  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);

  function cancelPasswordChange() {
    setChangingPassword(false);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
  }

  async function submitPasswordChange(event: React.FormEvent) {
    event.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords don't match");
      return;
    }
    setPasswordSaving(true);
    const response = await fetch("/api/portal/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await response.json().catch(() => ({}));
    setPasswordSaving(false);
    if (!response.ok) {
      setPasswordError(body.error ?? "failed to update password");
      return;
    }
    setPasswordSuccess(true);
    cancelPasswordChange();
  }

  const initials = client.fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

  const kycBadge = initialKycStatus ? KYC_BADGE[initialKycStatus] : null;

  return (
    <div className={styles.cardStack}>
      <div className={styles.profileHeader}>
        <div className={styles.avatarLarge}>{initials}</div>
        <div>
          <h2 className={styles.profileName}>{client.fullName}</h2>
          <div className={styles.profileEmail}>{client.email}</div>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.cardHeader}>
          <h3 className={styles.panelTitle} style={{ margin: 0 }}>Personal info</h3>
          {!editingPersonal ? (
            <button type="button" className={styles.linkBtn} onClick={() => setEditingPersonal(true)}>Edit</button>
          ) : null}
        </div>

        {editingPersonal ? (
          <form onSubmit={savePersonal}>
            <div className={styles.formGrid}>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Full name</label>
                <input className={styles.input} value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Phone</label>
                <input className={styles.input} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Not set" />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Country</label>
                <input className={styles.input} value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Not set" />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Date of birth</label>
                <input className={styles.input} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
              </div>
            </div>
            {personalError ? <div className={styles.formError}>{personalError}</div> : null}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button type="submit" className={styles.btnPrimary} style={{ margin: 0 }} disabled={personalSaving}>
                {personalSaving ? "Saving..." : "Save changes"}
              </button>
              <button type="button" onClick={cancelPersonal} style={cancelBtnStyle}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className={styles.formGrid} style={{ marginBottom: 0 }}>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Full name</span>
              <span className={styles.readFieldValue}>{client.fullName}</span>
            </div>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Email</span>
              <span className={styles.readFieldValue}>{client.email}</span>
            </div>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Phone</span>
              <span className={styles.readFieldValue}>{client.phone ?? "Not set"}</span>
            </div>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Country</span>
              <span className={styles.readFieldValue}>{client.country ?? "Not set"}</span>
            </div>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Date of birth</span>
              <span className={styles.readFieldValue}>{client.dateOfBirth ? new Date(client.dateOfBirth).toLocaleDateString() : "Not set"}</span>
            </div>
          </div>
        )}
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Verification</h3>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className={styles.readFieldValue}>Email address</span>
          <span
            className={styles.statusBadge}
            style={{
              color: client.emailVerifiedAt ? "var(--accent)" : "var(--text-2)",
              background: client.emailVerifiedAt ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "var(--bg-2)",
            }}
          >
            {client.emailVerifiedAt ? "Verified" : "Not verified"}
          </span>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.cardHeader}>
          <h3 className={styles.panelTitle} style={{ margin: 0 }}>KYC status</h3>
          <Link href="/portal/kyc" className={styles.linkBtn}>{initialKycStatus ? "View" : "Complete KYC"}</Link>
        </div>
        <span
          className={styles.statusBadge}
          style={{ color: kycBadge?.color ?? "var(--text-2)", background: kycBadge?.bg ?? "var(--bg-2)" }}
        >
          {kycBadge?.label ?? "Not submitted"}
        </span>
      </div>

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Security</h3>

        <div style={{ marginTop: 16 }}>
          <div className={styles.cardHeader} style={{ marginBottom: changingPassword ? 12 : 0 }}>
            <span className={styles.readFieldValue} style={{ fontWeight: 600 }}>Password</span>
            {!changingPassword ? (
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  setChangingPassword(true);
                  setPasswordSuccess(false);
                }}
              >
                Change password
              </button>
            ) : null}
          </div>
          {passwordSuccess ? <div className={styles.formNotice}>Password changed.</div> : null}
          {changingPassword ? (
            <form onSubmit={submitPasswordChange}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Current password</label>
                <input type="password" className={styles.input} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
              </div>
              <div className={styles.formGrid}>
                <div className={styles.field} style={{ marginBottom: 0 }}>
                  <label className={styles.fieldLabel}>New password</label>
                  <input type="password" className={styles.input} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required />
                </div>
                <div className={styles.field} style={{ marginBottom: 0 }}>
                  <label className={styles.fieldLabel}>Confirm new password</label>
                  <input type="password" className={styles.input} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} required />
                </div>
              </div>
              {passwordError ? <div className={styles.formError}>{passwordError}</div> : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" className={styles.btnPrimary} style={{ margin: 0 }} disabled={passwordSaving}>
                  {passwordSaving ? "Saving..." : "Update password"}
                </button>
                <button type="button" onClick={cancelPasswordChange} style={cancelBtnStyle}>Cancel</button>
              </div>
            </form>
          ) : null}
        </div>

        <hr className={styles.divider} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className={styles.readFieldValue} style={{ fontWeight: 600 }}>
            Two-factor authentication
            <span className={styles.comingSoon}>Coming soon</span>
          </span>
        </div>

        <hr className={styles.divider} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className={styles.readFieldValue} style={{ fontWeight: 600 }}>
            Active sessions
            <span className={styles.comingSoon}>Coming soon</span>
          </span>
        </div>
      </div>
    </div>
  );
}
