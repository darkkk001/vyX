"use client";

import { useCallback, useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { day, dayTime, initials } from "@/components/room/format";
import { ALL_AVATARS, avatarLabel, avatarPath } from "@/lib/avatars";

// Artboard "Profile & security": personal information (locked after KYC), documents, 2FA, password, active sessions.
type Profile = {
  personal: { fullName: string; email: string; phone: string | null; country: string | null; dateOfBirth: string | null; clientId: string; registeredAt: string; locked: boolean };
  documents: { name: string; state: string; at: string | null }[];
  rejectionReason: string | null;
  twoFactorEnabled: boolean;
  sessions: { id: string; device: string; ip: string | null; at: string | null; current: boolean }[];
  bitmoji: { canConnect: boolean; avatarUrl: string | null; appName: string } | null; // null = Bitmoji connect is off for this broker
  avatar: { type: "bitmoji" | "preset" | "none"; preset: string | null; url: string | null }; // what shows (lib/avatars.ts)
};
// what /api/bitmoji/callback (or /start) sent back, as ?bitmoji=<result>
const BITMOJI_RESULT: Record<string, string> = {
  connected: "Bitmoji connected.",
  cancelled: "Bitmoji connect was cancelled.",
  expired: "That sign-in expired. Try again.",
  failed: "Could not connect Bitmoji. Try again.",
  "no-avatar": "No Bitmoji found on that Snapchat account.",
  verify: "Bitmoji connect is for verified clients only.",
  off: "Bitmoji connect is not available.",
};
const DOC_COLOR: Record<string, string> = { Approved: "var(--r-ok)", "Under review": "var(--r-pending)", Rejected: "var(--r-loss)", "Not uploaded": "var(--r-muted)" };
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
    if (res.status === 401) { window.location.assign("/login"); return; }
    if (res.ok) setP(await res.json());
  }, []);
  useEffect(() => { void load(); }, [load]);
  useRoomEvent(() => { void load(); });
  const { refresh } = useRoom();

  // Bitmoji: the result of the connect round trip. From the sign-in tab (BroadcastChannel, or postMessage while Snap's
  // pages kept the opener): shown here at once, the avatar redrawn, no reload. Same-page fallback: ?bitmoji=<result>,
  // read once and removed from the address.
  const [bmMsg, setBmMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bmBusy, setBmBusy] = useState(false);
  const [bmAsk, setBmAsk] = useState(false);
  const showBitmojiResult = useCallback((r: string) => {
    setBmMsg({ ok: r === "connected", text: BITMOJI_RESULT[r] ?? BITMOJI_RESULT.failed });
    void load();
    void refresh();
  }, [load, refresh]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const r = url.searchParams.get("bitmoji");
    if (!r) return;
    setBmMsg({ ok: r === "connected", text: BITMOJI_RESULT[r] ?? BITMOJI_RESULT.failed });
    url.searchParams.delete("bitmoji");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);
  useEffect(() => {
    const take = (d: unknown) => { const r = (d as { bitmoji?: unknown } | null)?.bitmoji; if (typeof r === "string" && r in BITMOJI_RESULT) showBitmojiResult(r); };
    let ch: BroadcastChannel | null = null;
    try { ch = new BroadcastChannel("bitmoji-connect"); ch.onmessage = (e) => take(e.data); } catch { /* old browser: postMessage below */ }
    const onMsg = (e: MessageEvent) => { if (e.origin === window.location.origin) take(e.data); };
    window.addEventListener("message", onMsg);
    return () => { ch?.close(); window.removeEventListener("message", onMsg); };
  }, [showBitmojiResult]);
  // "Bitmoji connected." shows for a few seconds after connecting, then goes
  useEffect(() => {
    if (bmMsg?.text !== BITMOJI_RESULT.connected) return;
    const t = setTimeout(() => setBmMsg((m) => (m?.text === BITMOJI_RESULT.connected ? null : m)), 4000);
    return () => clearTimeout(t);
  }, [bmMsg]);
  useEffect(() => {
    if (!bmAsk) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBmAsk(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bmAsk]);
  /** Continue in the popup: Snap's sign-in in a new tab; if the browser blocks it, in this page as before. */
  function continueBitmoji() {
    setBmAsk(false);
    setBmMsg(null);
    const w = window.open("/api/bitmoji/start?tab=1", "_blank");
    if (!w) window.location.assign("/api/bitmoji/start");
  }
  async function disconnectBitmoji() {
    if (bmBusy) return;
    setBmBusy(true);
    try {
      const res = await fetch("/api/bitmoji", { method: "DELETE" });
      setBmMsg(res.ok ? { ok: true, text: "Bitmoji disconnected." } : { ok: false, text: "Could not disconnect. Try again." });
      if (res.ok) { await load(); await refresh(); }
    } catch {
      setBmMsg({ ok: false, text: "No connection. Try again." });
    }
    setBmBusy(false);
  }

  // Choose avatar (owner 2026-11-14): one of the preset pictures, or the initials; saved at once
  const [pickOpen, setPickOpen] = useState(false);
  const [pickMsg, setPickMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!pickOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickOpen]);
  async function pickAvatar(preset: string | null) {
    setPickMsg(null);
    try {
      const res = await fetch("/api/room/avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset }) });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setPickMsg(body?.error ?? "Could not save. Try again."); return; }
      setPickOpen(false);
      await load();
      await refresh();
    } catch {
      setPickMsg("No connection. Try again.");
    }
  }

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
    if (id === "current") { window.location.assign("/login"); return; }
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
              <div className="r-bitmoji-row">
                {p.avatar.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="r-avatar r-avatar-img r-avatar-lg" src={p.avatar.url} alt={p.avatar.type === "bitmoji" ? "Your Bitmoji" : "Your avatar"} referrerPolicy="no-referrer" />
                ) : <span className="r-avatar r-avatar-lg">{initials(p.personal.fullName)}</span>}
                <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => { setPickMsg(null); setPickOpen(true); }}>Choose avatar</button>
                {p.bitmoji && (p.bitmoji.avatarUrl || p.bitmoji.canConnect) ? (p.bitmoji.avatarUrl ? (
                  <button type="button" className="r-btn-ghost r-btn-sm" disabled={bmBusy} onClick={disconnectBitmoji}>{bmBusy ? "Disconnecting…" : "Disconnect"}</button>
                ) : <a className="r-btn r-btn-sm" href="/api/bitmoji/start" onClick={(e) => { e.preventDefault(); setBmAsk(true); }}>Connect Bitmoji</a>) : null}
              </div>
            ) : null}
            {pickOpen && p ? (
              <div className="r-modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) setPickOpen(false); }}>
                <div className="r-modal" role="dialog" aria-modal="true" aria-label="Choose avatar" style={{ maxWidth: 460 }}>
                  <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>Choose avatar</div>
                  {p.avatar.type === "bitmoji" ? <div style={small}>Your Bitmoji shows while it is connected.</div> : null}
                  <div className="r-avatar-grid">
                    {ALL_AVATARS.map((name) => (
                      <button key={name} type="button" className="r-avatar-pick" aria-pressed={p.avatar.preset === name} title={avatarLabel(name)} aria-label={avatarLabel(name)} onClick={() => void pickAvatar(name)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={avatarPath(name, 96)} srcSet={`${avatarPath(name, 96)} 1x, ${avatarPath(name, 256)} 2x`} alt="" loading="lazy" />
                      </button>
                    ))}
                    <button type="button" className="r-avatar-pick r-avatar-pick-none" aria-pressed={!p.avatar.preset} title="Initials" aria-label="Initials" onClick={() => void pickAvatar(null)}>{initials(p.personal.fullName)}</button>
                  </div>
                  {pickMsg ? <div role="status" style={{ fontSize: 12, color: "var(--r-loss)" }}>{pickMsg}</div> : null}
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => setPickOpen(false)}>Close</button>
                  </div>
                </div>
              </div>
            ) : null}
            {bmAsk ? (
              <div className="r-modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) setBmAsk(false); }}>
                <div className="r-modal" role="dialog" aria-modal="true" aria-label="Connect your Bitmoji" style={{ maxWidth: 420 }}>
                  <div style={{ fontFamily: "var(--r-head)", fontSize: 18, fontWeight: 600 }}>Connect your Bitmoji</div>
                  <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8, fontSize: 13, color: "var(--r-text-2)", lineHeight: 1.5 }}>
                    <li>We use your Snapchat login one time, only to get your Bitmoji image.</li>
                    <li>After that the connection ends. We don&apos;t keep your login.</li>
                    <li>We never see your password, chats, friends or any other Snapchat data.</li>
                    <li>You can check or remove {p?.bitmoji?.appName ?? "us"} anytime in Snapchat settings, under Connected apps.</li>
                  </ul>
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
                    <button type="button" className="r-btn-ghost r-btn-sm" onClick={() => setBmAsk(false)}>Cancel</button>
                    <button type="button" className="r-btn r-btn-sm" autoFocus onClick={continueBitmoji}>Continue</button>
                  </div>
                </div>
              </div>
            ) : null}
            {bmMsg ? <div role="status" style={{ fontSize: 12, color: bmMsg.ok ? "var(--r-ok)" : "var(--r-loss)" }}>{bmMsg.text}</div> : null}
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
            <div className="r-sessions" style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 12.5 }}>
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
