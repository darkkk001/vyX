"use client";

import { useCallback, useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoomEvent } from "@/components/room/RoomData";
import { day, dayTime } from "@/components/room/format";

// Artboard "Profile & security": personal information (locked after KYC), documents, 2FA, password, active sessions.
type Profile = {
  personal: { fullName: string; email: string; phone: string | null; country: string | null; dateOfBirth: string | null; clientId: string; registeredAt: string; locked: boolean };
  documents: { name: string; state: string; at: string | null }[];
  rejectionReason: string | null;
  twoFactorEnabled: boolean;
  sessions: { id: string; device: string; ip: string | null; at: string | null; current: boolean }[];
};
const DOC_COLOR: Record<string, string> = { Approved: "var(--r-ok)", "Pending": "var(--r-pending)", Rejected: "var(--r-loss)", "Not uploaded": "var(--r-muted)" };
const Field = ({ k, v, mono }: { k: string; v: string | null; mono?: boolean }) => (
  <div><div style={{ color: "var(--r-muted)", fontSize: 11, marginBottom: 4 }}>{k}</div><div className={mono ? "mono" : undefined} style={{ wordBreak: "break-word" }}>{v || "Not given"}</div></div>
);
const card = { padding: 24, display: "flex", flexDirection: "column", gap: 16 } as const;
const small = { fontSize: 11, color: "var(--r-muted)" } as const;

function countryName(code: string | null): string | null {
  if (!code) return null;
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

export default function RoomProfile() {
  const [p, setP] = useState<Profile | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/room/profile", { cache: "no-store" });
    if (res.status === 401) { window.location.assign("/portal/login"); return; }
    if (res.ok) setP(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });

  // password
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function changePassword() {
    setPwMsg(null);
    const res = await fetch("/api/room/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: cur, next }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setPwMsg({ ok: false, text: body?.error ?? "Could not change the password." }); return; }
    setCur(""); setNext("");
    setPwMsg({ ok: true, text: "Password changed. Other devices are signed out." });
    void load();
  }

  // 2FA
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [offPw, setOffPw] = useState("");
  const [turningOff, setTurningOff] = useState(false);
  const [tfMsg, setTfMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function twoFactor(action: "setup" | "confirm" | "disable") {
    setTfMsg(null);
    const res = await fetch("/api/room/two-factor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, code, password: offPw }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setTfMsg({ ok: false, text: body?.error ?? "Try again." }); return; }
    if (action === "setup") { setSetup(body); setCode(""); return; }
    setSetup(null); setCode(""); setOffPw(""); setTurningOff(false);
    setTfMsg({ ok: true, text: action === "confirm" ? "2FA is on." : "2FA is off." });
    void load();
  }

  async function endSession(id: string) {
    const res = await fetch(`/api/room/sessions?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (id === "current") { window.location.assign("/portal/login"); return; }
    if (res.ok) void load();
  }

  const signOut = <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => endSession("current")}>Sign out</button>;
  return (
    <>
      <RoomHeader title="Profile & security" right={signOut} picker={false} />
      <div className="r-body" style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="r-card" style={card}>
            <div className="r-label">Personal information</div>
            {p ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, fontSize: 13 }}>
                <Field k="Full name" v={p.personal.fullName} />
                <Field k="Email" v={p.personal.email} />
                <Field k="Phone" v={p.personal.phone} mono />
                <Field k="Country" v={countryName(p.personal.country)} />
                <Field k="Client ID" v={p.personal.clientId} mono />
                <Field k="Registered" v={day(p.personal.registeredAt)} mono />
              </div>
            ) : <div style={{ height: 96 }} />}
            <div style={{ fontSize: 11.5, color: "var(--r-faint)", borderTop: "1px solid var(--r-line)", paddingTop: 14 }}>
              {p && !p.personal.locked ? "Name and country lock once your documents are approved." : "Name and country are locked after verification. Contact support to request a change."}
            </div>
          </div>

          <div className="r-card" style={card}>
            <div className="r-label">Documents</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
              {(p?.documents ?? []).map((d) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <span>{d.name}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: DOC_COLOR[d.state] ?? "var(--r-muted)" }}>{d.state}{d.at && d.state === "Approved" ? ` · ${day(d.at)}` : ""}</span>
                </div>
              ))}
            </div>
            {p?.rejectionReason ? <div className="r-error" style={{ fontSize: 12 }}>{p.rejectionReason}</div> : null}
            {p && p.documents.some((d) => d.state === "Not uploaded" || d.state === "Rejected") ? <a href="/room/verify" style={{ fontSize: 12.5, fontWeight: 500 }}>Upload documents</a> : null}
          </div>
        </div>

        <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="r-card" style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div className="r-label">Two-factor authentication</div>
              <span style={{ fontSize: 11, fontWeight: 600, color: p?.twoFactorEnabled ? "var(--r-ok)" : "var(--r-pending)" }}>{p?.twoFactorEnabled ? "ON" : "OFF"}</span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--r-text-2)", lineHeight: 1.6 }}>Add a 6-digit code from an authenticator app at sign-in and on every withdrawal.</div>
            {setup ? (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qr} alt="Scan with your authenticator app" width={148} height={148} style={{ background: "#fff", borderRadius: 6, padding: 6 }} />
                <div style={{ flex: "1 1 180px", display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={small}>Or enter this key</div>
                  <div className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{setup.secret}</div>
                  <label htmlFor="tfcode" style={small}>Code from the app</label>
                  <input id="tfcode" className="r-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 160, padding: "10px 12px" }} />
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" className="r-btn r-btn-sm" disabled={code.length !== 6} onClick={() => twoFactor("confirm")}>Turn on</button>
                    <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => setSetup(null)}>Cancel</button>
                  </div>
                </div>
              </div>
            ) : p?.twoFactorEnabled ? (
              turningOff ? (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div className="r-field"><label htmlFor="offpw" style={small}>Password</label><input id="offpw" type="password" className="r-input" value={offPw} onChange={(e) => setOffPw(e.target.value)} style={{ padding: "10px 12px" }} /></div>
                  <div className="r-field"><label htmlFor="offcode" style={small}>Code</label><input id="offcode" className="r-input mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 120, padding: "10px 12px" }} /></div>
                  <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => twoFactor("disable")}>Turn off</button>
                </div>
              ) : <button type="button" className="r-btn-ghost r-btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setTurningOff(true)}>Turn off 2FA</button>
            ) : (
              <button type="button" className="r-btn" style={{ alignSelf: "flex-start", padding: "10px 20px" }} onClick={() => twoFactor("setup")}>Enable 2FA</button>
            )}
            {tfMsg ? <div className={tfMsg.ok ? "r-okmsg" : "r-error"} role="status">{tfMsg.text}</div> : null}
          </div>

          <div className="r-card" style={card}>
            <div className="r-label">Change password</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor="cpw" style={small}>Current password</label>
                <input id="cpw" type="password" autoComplete="current-password" className="r-input" value={cur} onChange={(e) => setCur(e.target.value)} style={{ fontSize: 13.5, padding: "10px 12px" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label htmlFor="npw" style={small}>New password</label>
                <input id="npw" type="password" autoComplete="new-password" className="r-input" value={next} onChange={(e) => setNext(e.target.value)} style={{ fontSize: 13.5, padding: "10px 12px" }} />
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "var(--r-faint)" }}>Also the password of your trading accounts.</div>
            <button type="button" className="r-btn-ghost" style={{ alignSelf: "flex-start", fontSize: 12.5, padding: "10px 18px" }} disabled={!cur || !next} onClick={changePassword}>Update password</button>
            {pwMsg ? <div className={pwMsg.ok ? "r-okmsg" : "r-error"} role="status">{pwMsg.text}</div> : null}
          </div>

          <div className="r-card" style={{ ...card, gap: 14 }}>
            <div className="r-label">Active sessions</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
              {(p?.sessions ?? []).filter((s) => s.current || s.device !== "Unknown device").map((s, i) => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", borderTop: i ? "1px solid var(--r-row)" : "none", paddingTop: i ? 12 : 0 }}>
                  <div>
                    <div>{s.device}</div>
                    <div style={{ color: "var(--r-muted)", fontSize: 11.5, marginTop: 3 }}>{s.current ? "This device" : s.at ? `Signed in ${dayTime(s.at)}` : "Signed in earlier"}</div>
                  </div>
                  {s.current
                    ? <span style={{ fontSize: 11, fontWeight: 600, color: "var(--r-ok)" }}>CURRENT</span>
                    : <button type="button" onClick={() => endSession(s.id)} style={{ background: "none", border: "none", color: "var(--r-loss)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: 0 }}>End session</button>}
                </div>
              ))}
              {p && p.sessions.some((s) => !s.current && s.device === "Unknown device") ? (
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", borderTop: "1px solid var(--r-row)", paddingTop: 12 }}>
                  <div>
                    <div>Older sessions</div>
                    <div style={{ color: "var(--r-muted)", fontSize: 11.5, marginTop: 3 }}>{p.sessions.filter((s) => !s.current && s.device === "Unknown device").length} from before device details were kept</div>
                  </div>
                  <button type="button" onClick={() => endSession("others")} style={{ background: "none", border: "none", color: "var(--r-loss)", fontSize: 12, fontWeight: 500, cursor: "pointer", padding: 0 }}>End all others</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
