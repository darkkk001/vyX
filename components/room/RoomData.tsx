"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Trader's Room client state: GET /api/room/overview (the server's figures), the account picked in the header (kept per
// browser), and refresh(). Pages read it through useRoom(); nothing here computes money.
//
// Real time (~1 s): one observer socket per own account on the gateway's trading stream (POST /api/room/ws-ticket).
// Any event (balance, positions, terms, room.> funds / KYC / support) refetches the figures and fires "room:changed"
// for the screen's own lists (useRoomEvent). Floating P/L moves with prices, which are not events: while an account
// holds positions the figures are re-read every second. Otherwise a 30 s safety read.

export type RoomFigures = {
  balance: string; credit: string; equity: string; freeMargin: string; floating: string; usedMargin: string;
  marginLevel: string | null; openPositions: number; priced: boolean;
};
export type RoomAccount = { nickname: string | null; server: string; readOnlyPassword: boolean; id: string; accountNumber: string; mode: "LIVE" | "DEMO"; plan: string; leverage: number; currency: string; openedAt: string; portalPassword: boolean; figures: RoomFigures };
export type RoomTx = { id: string; ref: string; at: string; type: string; account: string; method: string; amount: string; currency: string; status: "Completed" | "Pending" | "Rejected" | "Cancelled" };
export type RoomOverview = {
  client: { fullName: string; email: string; clientId: string; lastLoginAt: string | null };
  kyc: { status: "NONE" | "PENDING" | "APPROVED" | "REJECTED"; identity: boolean; address: boolean; rejectionReason: string | null };
  accounts: RoomAccount[];
  wallet: RoomAccount | null;
  walletCurrency?: string; // the funding wallet's currency, also before it exists
  totals: { currency: string; balance: string; equity: string; freeMargin: string; floating: string } | null; // live accounts summed; null = mixed currencies
  realFunds: { amount: string; currency: string }; // the funding wallet, 0.00 until it exists
  recent: RoomTx[]; // live accounts (and the funding wallet)
  recentDemo: RoomTx[];
};

type Ctx = {
  data: RoomOverview | null;
  error: string;
  selected: RoomAccount | null;
  select: (accountId: string) => void;
  refresh: () => Promise<void>;
};

const RoomCtx = createContext<Ctx | null>(null);
const PICK_KEY = "room-account";
const SIGNED_OUT = "/login?signedOut=1";
const ACTIVITY_EVERY_MS = 60_000;

export function RoomDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<RoomOverview | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const inflight = useRef(false);
  const kycSeen = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch("/api/room/overview", { cache: "no-store" });
      if (res.status === 401) {
        window.location.assign(SIGNED_OUT);
        return;
      }
      if (!res.ok) {
        setError("Could not load your accounts. Retrying.");
        return;
      }
      const next = (await res.json()) as RoomOverview;
      if (kycSeen.current !== null && kycSeen.current !== next.kyc.status) window.dispatchEvent(new CustomEvent("room:changed", { detail: { type: "kyc" } }));
      kycSeen.current = next.kyc.status;
      setData(next);
      setError("");
    } catch {
      setError("No connection. Retrying.");
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    try { setPicked(localStorage.getItem(PICK_KEY)); } catch { /* storage blocked */ }
    void refresh();
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  // real input holds off the idle limit; the reads below do not (app/api/room/activity)
  useEffect(() => {
    let last = Date.now();
    const seen = () => {
      if (Date.now() - last < ACTIVITY_EVERY_MS) return;
      last = Date.now();
      void fetch("/api/room/activity", { method: "POST", cache: "no-store" }).then((r) => { if (r.status === 401) window.location.assign(SIGNED_OUT); }).catch(() => {});
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, seen, { passive: true });
    return () => { for (const e of events) window.removeEventListener(e, seen); };
  }, []);

  const holding = (data?.accounts ?? []).some((a) => a.figures.openPositions > 0);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, holding ? 1000 : 30000);
    return () => clearInterval(t);
  }, [refresh, holding]);

  // one observer socket per account, the funding wallet included (a wallet-only client still hears a deposit approved in
  // ~1 s, E2E 2026-11-09: it had no socket and waited for the 30 s refresh); reopened when the list changes or a socket drops
  const accountKey = [...(data?.accounts ?? []).map((a) => a.id), ...(data?.wallet ? [data.wallet.id] : [])].sort().join(",");
  useEffect(() => {
    if (!accountKey) return;
    const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL;
    if (!base) return;
    let stopped = false;
    let sockets: WebSocket[] = [];
    let retry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    const changed = (type: string) => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void refresh();
        window.dispatchEvent(new CustomEvent("room:changed", { detail: { type } }));
      }, 250);
    };
    const closeAll = () => { for (const s of sockets) { s.onclose = null; try { s.close(); } catch { /* closed */ } } sockets = []; };
    const reopen = () => {
      closeAll();
      if (stopped || retry) return;
      retry = setTimeout(() => { retry = null; void open(); }, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    async function open() {
      try {
        const res = await fetch("/api/room/ws-ticket", { method: "POST", cache: "no-store" });
        if (!res.ok || stopped) { if (!stopped) reopen(); return; }
        const { tickets } = (await res.json()) as { tickets: { accountId: string; ticket: string }[] };
        for (const t of tickets) {
          const ws = new WebSocket(`${base}/v1/trading/stream?ticket=${encodeURIComponent(t.ticket)}`);
          ws.onopen = () => { backoff = 1000; };
          ws.onmessage = (ev) => {
            try {
              const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
              if (!msg?.type || msg.type === "pong" || msg.type === "keepalive") return;
              changed(String(msg.type));
            } catch { /* not JSON */ }
          };
          ws.onclose = () => reopen();
          sockets.push(ws);
        }
      } catch {
        reopen();
      }
    }
    void open();
    return () => { stopped = true; if (retry) clearTimeout(retry); if (debounce) clearTimeout(debounce); closeAll(); };
  }, [accountKey, refresh]);

  const select = useCallback((id: string) => {
    setPicked(id);
    try { localStorage.setItem(PICK_KEY, id); } catch { /* storage blocked */ }
  }, []);

  const selected = useMemo(() => {
    const list = data?.accounts ?? [];
    return list.find((a) => a.id === picked) ?? list.find((a) => a.mode === "LIVE") ?? list[0] ?? null;
  }, [data, picked]);

  const value = useMemo(() => ({ data, error, selected, select, refresh }), [data, error, selected, select, refresh]);
  return <RoomCtx.Provider value={value}>{children}</RoomCtx.Provider>;
}

export function useRoom(): Ctx {
  const c = useContext(RoomCtx);
  if (!c) throw new Error("useRoom outside RoomDataProvider");
  return c;
}

/** Runs `fn` when the room hears a change (see the socket above): screens reload their own lists with it. */
export function useRoomEvent(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    window.addEventListener("room:changed", h);
    return () => window.removeEventListener("room:changed", h);
  }, []);
}
