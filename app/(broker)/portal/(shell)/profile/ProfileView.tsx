"use client";

import { useState } from "react";
import Link from "next/link";
import { plainError } from "@/lib/plain-error";
import styles from "@/components/portal/PortalShell.module.css";

type ClientProfile = {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  country: string | null;
  // YYYY-MM-DD (a DATE column, never shifted through the viewer's time zone)
  dateOfBirth: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  kycStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  // name / country / date of birth are locked while KYC is pending or verified (lib/client-profile.ts)
  identityLocked: boolean;
};

const KYC_BADGE: Record<string, { label: string; color: string; bg: string }> = {
  APPROVED: { label: "Verified", color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  PENDING: { label: "Pending", color: "var(--text-2)", bg: "var(--bg-2)" },
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

function formatDate(isoDate: string | null): string {
  if (!isoDate) return "Not set";
  return new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC" });
}

// Profile tab (restored and reviewed 2026-09-28 from the 2026-09-18 snapshot): Personal info and Password are
// editable (PATCH /api/portal/me, POST /api/portal/change-password); Verification and KYC read real data. Two-factor
// and active sessions have no backing model for Client yet, so they are shown as not available rather than as a
// toggle that does nothing.
export default function ProfileView({ initialClient }: { initialClient: ClientProfile }) {
  const [client, setClient] = useState(initialClient);

  const [editingPersonal, setEditingPersonal] = useState(false);
  const [fullName, setFullName] = useState(client.fullName);
  const [phone, setPhone] = useState(client.phone ?? "");
  const [country, setCountry] = useState(client.country ?? "");
  const [dateOfBirth, setDateOfBirth] = useState(client.dateOfBirth ?? "");
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [personalSaved, setPersonalSaved] = useState(false);
  const [personalSaving, setPersonalSaving] = useState(false);

  function resetPersonal(from: ClientProfile) {
    setFullName(from.fullName);
    setPhone(from.phone ?? "");
    setCountry(from.country ?? "");
    setDateOfBirth(from.dateOfBirth ?? "");
  }

  function cancelPersonal() {
    resetPersonal(client);
    setPersonalError(null);
    setEditingPersonal(false);
  }

  async function savePersonal(event: React.FormEvent) {
    event.preventDefault();
    setPersonalSaving(true);
    setPersonalError(null);
    setPersonalSaved(false);
    // locked identity fields are not sent at all: only the phone can change then
    const payload = client.identityLocked ? { phone } : { fullName, phone, country, dateOfBirth: dateOfBirth || null };
    try {
      const response = await fetch("/api/portal/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPersonalError(plainError(body, "Could not save. Try again."));
        return;
      }
      setClient(body);
      resetPersonal(body);
      setEditingPersonal(false);
      setPersonalSaved(true);
    } catch {
      setPersonalError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPersonalSaving(false);
    }
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
    try {
      const response = await fetch("/api/portal/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPasswordError(plainError(body, "Could not update the password. Try again."));
        return;
      }
      cancelPasswordChange();
      setPasswordSuccess(true);
    } catch {
      setPasswordError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPasswordSaving(false);
    }
  }

  const initials =
    client.fullName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";

  const kycBadge = client.kycStatus ? KYC_BADGE[client.kycStatus] : null;
  const lockedHint = "Locked after KYC submission. Contact support to change it.";

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
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                setEditingPersonal(true);
                setPersonalSaved(false);
              }}
            >
              Edit
            </button>
          ) : null}
        </div>
        {personalSaved ? <div className={styles.formNotice}>Your details were saved.</div> : null}

        {editingPersonal ? (
          <form onSubmit={savePersonal}>
            {client.identityLocked ? (
              <p className={styles.panelText} style={{ color: "var(--text-3)", fontSize: 12, marginTop: 0 }}>
                Your KYC has been submitted, so your name, country and date of birth are locked. Contact support to change
                them. You can still update your phone number.
              </p>
            ) : null}
            <div className={styles.formGrid}>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Full name</label>
                <input
                  className={styles.input}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  maxLength={100}
                  disabled={client.identityLocked}
                  title={client.identityLocked ? lockedHint : undefined}
                />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Phone</label>
                <input className={styles.input} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Not set" maxLength={32} />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Country</label>
                <input
                  className={styles.input}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="Not set"
                  maxLength={64}
                  disabled={client.identityLocked}
                  title={client.identityLocked ? lockedHint : undefined}
                />
              </div>
              <div className={styles.field} style={{ marginBottom: 0 }}>
                <label className={styles.fieldLabel}>Date of birth</label>
                <input
                  className={styles.input}
                  type="date"
                  value={dateOfBirth}
                  onChange={(e) => setDateOfBirth(e.target.value)}
                  max={new Date().toISOString().slice(0, 10)}
                  disabled={client.identityLocked}
                  title={client.identityLocked ? lockedHint : undefined}
                />
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
              <span className={styles.readFieldValue}>{formatDate(client.dateOfBirth)}</span>
            </div>
            <div className={styles.readField}>
              <span className={styles.readFieldLabel}>Member since</span>
              <span className={styles.readFieldValue}>{new Date(client.createdAt).toLocaleDateString()}</span>
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
          <Link href="/portal/kyc" className={styles.linkBtn}>{client.kycStatus ? "View" : "Complete your KYC"}</Link>
        </div>
        <span className={styles.statusBadge} style={{ color: kycBadge?.color ?? "var(--text-2)", background: kycBadge?.bg ?? "var(--bg-2)" }}>
          {kycBadge?.label ?? "Not verified"}
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
          {passwordSuccess ? <div className={styles.formNotice}>Password changed. Other devices were signed out.</div> : null}
          {changingPassword ? (
            <form onSubmit={submitPasswordChange}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Current password</label>
                <input type="password" autoComplete="current-password" className={styles.input} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
              </div>
              <div className={styles.formGrid}>
                <div className={styles.field} style={{ marginBottom: 0 }}>
                  <label className={styles.fieldLabel}>New password</label>
                  <input type="password" autoComplete="new-password" className={styles.input} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} maxLength={72} required />
                </div>
                <div className={styles.field} style={{ marginBottom: 0 }}>
                  <label className={styles.fieldLabel}>Confirm new password</label>
                  <input type="password" autoComplete="new-password" className={styles.input} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={8} maxLength={72} required />
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
