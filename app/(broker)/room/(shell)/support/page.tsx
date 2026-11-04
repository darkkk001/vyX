"use client";

import { useCallback, useEffect, useState } from "react";
import RoomHeader from "@/components/room/RoomHeader";
import { useRoom, useRoomEvent } from "@/components/room/RoomData";
import { day, dayTime, initials } from "@/components/room/format";

// Artboard "Support": my tickets, the selected thread, reply; "New ticket" in the header.
type Ticket = { id: string; ref: string; subject: string; status: "OPEN" | "ANSWERED" | "RESOLVED"; createdAt: string; updatedAt: string; resolvedAt: string | null };
type Msg = { id: string; from: "client" | "support"; body: string; at: string };
const resolved = (t: Ticket) => t.status === "RESOLVED";
const statusColor = (t: Ticket) => (resolved(t) ? "var(--r-ok)" : "var(--r-pending)");
const statusText = (t: Ticket) => (resolved(t) ? "RESOLVED" : "OPEN");

export default function RoomSupport() {
  const { data } = useRoom();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ ticket: Ticket; messages: Msg[] } | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [reply, setReply] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const res = await fetch("/api/room/support", { cache: "no-store" });
    if (!res.ok) return;
    const body = await res.json();
    setTickets(body.tickets);
    setOpenId((cur) => cur ?? body.tickets[0]?.id ?? null);
  }, []);
  const loadThread = useCallback(async (id: string) => {
    const res = await fetch(`/api/room/support/${id}`, { cache: "no-store" });
    if (res.ok) setThread(await res.json());
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  useRoomEvent(() => { void loadList(); if (openId) void loadThread(openId); });
  useEffect(() => { if (openId) void loadThread(openId); }, [openId, loadThread]);
  // a staff reply shows up without a reload
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") { void loadList(); if (openId) void loadThread(openId); } }, 15000);
    return () => clearInterval(t);
  }, [loadList, loadThread, openId]);

  async function create() {
    setErr(""); setBusy(true);
    const res = await fetch("/api/room/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, body: text }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setErr(body?.error ?? "Could not open the ticket."); return; }
    setComposing(false); setSubject(""); setText("");
    setOpenId(body.ticket.id);
    await loadList();
  }
  async function send() {
    if (!openId || !reply.trim()) return;
    setErr(""); setBusy(true);
    const res = await fetch(`/api/room/support/${openId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: reply }) });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setErr(body?.error ?? "Could not send."); return; }
    setReply("");
    await Promise.all([loadThread(openId), loadList()]);
  }

  const newBtn = <button type="button" className="r-btn r-btn-sm" onClick={() => { setComposing(true); setErr(""); }}>New ticket</button>;
  const me = initials(data?.client.fullName ?? "");
  return (
    <>
      <RoomHeader title="Support" right={newBtn} picker={false} />
      <div className="r-body" style={{ flexDirection: "row", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="r-label" style={{ padding: "2px 2px 4px" }}>My tickets</div>
          {(tickets ?? []).map((t) => {
            const sel = !composing && openId === t.id;
            return (
              <button key={t.id} type="button" aria-pressed={sel} onClick={() => { setComposing(false); setOpenId(t.id); setErr(""); }}
                style={{ textAlign: "left", background: sel ? "var(--r-gold-tint)" : "var(--r-card)", border: sel ? "1.5px solid var(--r-accent)" : "1px solid var(--r-border)", borderRadius: 10, padding: 16, cursor: "pointer", color: "var(--r-text)", display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)" }}>{t.ref}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: statusColor(t) }}>{statusText(t)}</span>
                </div>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{t.subject}</span>
                <span style={{ fontSize: 11.5, color: "var(--r-muted)" }}>{resolved(t) && t.resolvedAt ? `Closed ${day(t.resolvedAt)}` : `Updated ${dayTime(t.updatedAt)}`}</span>
              </button>
            );
          })}
          {tickets && tickets.length === 0 && !composing ? <div className="r-note">No tickets yet. Use New ticket to reach your broker.</div> : null}
        </div>

        <div className="r-card" style={{ flex: "2 1 460px", minWidth: 0, display: "flex", flexDirection: "column" }}>
          {composing ? (
            <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>New ticket</div>
              <div className="r-field"><label htmlFor="subj">Subject</label><input id="subj" className="r-input" maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
              <div className="r-field"><label htmlFor="msg">Message</label><textarea id="msg" className="r-input" rows={6} maxLength={5000} value={text} onChange={(e) => setText(e.target.value)} style={{ resize: "vertical", fontSize: 13 }} /></div>
              {err ? <div className="r-error">{err}</div> : null}
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" className="r-btn" disabled={busy || !subject.trim() || !text.trim()} onClick={create}>{busy ? "Sending…" : "Send"}</button>
                <button type="button" className="r-btn-ghost" onClick={() => setComposing(false)}>Cancel</button>
              </div>
            </div>
          ) : thread ? (
            <>
              <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--r-line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{thread.ticket.subject}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--r-muted)", marginTop: 4 }}>{thread.ticket.ref} · opened {day(thread.ticket.createdAt)}</div>
                </div>
                <span style={{ fontSize: 10.5, letterSpacing: 1, fontWeight: 700, color: statusColor(thread.ticket), border: "1px solid currentColor", borderRadius: 5, padding: "3px 8px" }}>{statusText(thread.ticket)}</span>
              </div>
              <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
                {thread.messages.map((m) => (
                  <div key={m.id} style={{ display: "flex", gap: 12 }}>
                    <span style={{ width: 28, height: 28, borderRadius: "50%", background: m.from === "client" ? "var(--r-avatar)" : "var(--r-gold-soft)", color: m.from === "client" ? "var(--r-text)" : "var(--r-gold-text)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>{m.from === "client" ? me : "S"}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, color: "var(--r-muted)", marginBottom: 5 }}>{m.from === "client" ? "You" : "Support"} · {dayTime(m.at)}</div>
                      <div style={{ background: "var(--r-card-2)", border: "1px solid var(--r-border)", borderRadius: 8, padding: "12px 14px", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: "auto", padding: "16px 22px", borderTop: "1px solid var(--r-line)", display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div className="r-field" style={{ flex: 1, minWidth: 200, gap: 6 }}>
                  <label htmlFor="reply">Reply</label>
                  <textarea id="reply" className="r-input" rows={2} maxLength={5000} value={reply} onChange={(e) => setReply(e.target.value)} style={{ resize: "vertical", fontSize: 13, padding: "10px 12px" }} />
                </div>
                <button type="button" className="r-btn" style={{ padding: "10px 20px" }} disabled={busy || !reply.trim()} onClick={send}>{busy ? "Sending…" : "Send"}</button>
              </div>
              {err ? <div className="r-error" style={{ padding: "0 22px 16px" }}>{err}</div> : null}
            </>
          ) : (
            <div className="r-empty">Open a ticket to see the conversation.</div>
          )}
        </div>
      </div>
    </>
  );
}
