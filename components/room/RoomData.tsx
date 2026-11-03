"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// Trader's Room client state: GET /api/room/overview (the server's figures), the account picked in the header (kept per
// browser), and refresh(). Pages read it through useRoom(); nothing here computes money.

export type RoomFigures = {
  balance: string; credit: string; equity: string; freeMargin: string; floating: string; usedMargin: string;
  marginLevel: string | null; openPositions: number; priced: boolean;
};
export type RoomAccount = { id: string; accountNumber: string; mode: "LIVE" | "DEMO"; plan: string; leverage: number; currency: string; openedAt: string; portalPassword: boolean; figures: RoomFigures };
export type RoomTx = { id: string; ref: string; at: string; type: string; account: string; method: string; amount: string; currency: string; status: "Completed" | "Pending" | "Rejected" | "Cancelled" };
export type RoomOverview = {
  client: { fullName: string; email: string; clientId: string; lastLoginAt: string | null };
  kyc: { status: "NONE" | "PENDING" | "APPROVED" | "REJECTED"; identity: boolean; address: boolean; rejectionReason: string | null };
  accounts: RoomAccount[];
  totals: { currency: string; balance: string; equity: string; freeMargin: string; floating: string } | null;
  recent: RoomTx[];
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

export function RoomDataProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<RoomOverview | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch("/api/room/overview", { cache: "no-store" });
      if (res.status === 401) {
        window.location.assign("/room/login");
        return;
      }
      if (!res.ok) {
        setError("Could not load your accounts. Retrying.");
        return;
      }
      setData(await res.json());
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
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);

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
