"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// Backoffice real-time sync (fix/realtime-sync §1) -- the Manager/Broker-
// Admin equivalent of components/webtrader/WebTrader.tsx's own trading-
// stream effect, generalized into one shared provider instead of each
// page rolling its own WebSocket. Mounted once per backoffice shell
// (components/admin/NextAdminShell.tsx for the website; manager-shell/
// admin-shell's own App.tsx for the bundled Tauri apps -- see this
// file's own note on why the desktop apps don't yet get a native relay
// the way WebTrader.tsx's two streams do), never per page -- every page
// that needs live updates calls useAdminEventStream() to subscribe
// without opening its own socket.
//
// Server-side counterpart: services/api-gateway/src/ws.ts's
// attachAdminEventStream, subscribing to order.>/position.>/dealing.>/
// account.> and forwarding only messages whose broker_id matches this
// admin's own session (see lib/nats.ts's publishTradingEvent, which now
// requires broker_id on every call).
//
// Known gap: unlike WebTrader.tsx's price/trading streams, this doesn't
// yet check `window.vyxDesktop?.onAdminEvent` for a native Tauri relay --
// no such relay exists in manager-tauri/admin-tauri today. It falls
// straight to a plain browser WebSocket, which is what the live website
// (this fix's actual tested surface) always used anyway; the packaged
// desktop Manager/Super-Admin apps get this same fix once (if) that
// native relay is built, same shape as desktop-tauri's own.
export type AdminEvent = {
  type: string;
  broker_id: string;
  [key: string]: unknown;
};

// Dispatched to every subscriber once after a connection is
// (re-)established following at least one prior disconnect -- never on
// the very first connect. Handlers that hold their own local cache
// (e.g. DealingQueueManager's rows) use this to refetch once, per this
// fix's §1 "on reconnect, refetch everything once" rule; a missed event
// during the outage would otherwise never arrive any other way, since
// this stream (unlike NATS itself) has no replay/catch-up.
export const ADMIN_STREAM_RECONNECTED = "__admin_stream_reconnected__";

export type AdminConnectionStatus = "connecting" | "live" | "reconnecting";

type Handler = (event: AdminEvent) => void;

type AdminRealtimeContextValue = {
  status: AdminConnectionStatus;
  subscribe: (handler: Handler) => () => void;
};

const AdminRealtimeContext = createContext<AdminRealtimeContextValue | null>(null);

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 15000;

// `enabled: false` skips opening the socket entirely and holds `status`
// at "live" (so AdminShell's pill never renders) -- for Super Admin
// sessions, which the gateway's attachAdminEventStream hard-403s
// (brokerId: null is explicitly out of scope, see that function's own
// doc comment). Without this, a Super Admin session got a 401/403 on
// every connect attempt forever, and the client had no way to tell that
// permanent rejection apart from a transient outage -- the "Reconnecting…"
// pill was stuck for the lifetime of every Super Admin session.
export function AdminRealtimeProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [status, setStatus] = useState<AdminConnectionStatus>(enabled ? "connecting" : "live");
  const handlersRef = useRef<Set<Handler>>(new Set());

  const subscribe = useCallback((handler: Handler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = INITIAL_BACKOFF_MS;
    let everConnected = false;

    function connect() {
      if (cancelled) return;
      const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://127.0.0.1:8080";
      socket = new WebSocket(`${base}/v1/events/stream`);

      socket.onopen = () => {
        backoffMs = INITIAL_BACKOFF_MS;
        setStatus("live");
        if (everConnected) {
          const reconnectEvent: AdminEvent = { type: ADMIN_STREAM_RECONNECTED, broker_id: "" };
          for (const handler of handlersRef.current) handler(reconnectEvent);
        }
        everConnected = true;
      };
      socket.onmessage = (evt) => {
        let parsed: AdminEvent | null = null;
        try {
          parsed = JSON.parse(evt.data as string) as AdminEvent;
        } catch {
          return; // malformed -- nothing a handler could act on
        }
        for (const handler of handlersRef.current) handler(parsed);
      };
      socket.onclose = () => {
        if (cancelled) return;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      };
      socket.onerror = () => socket?.close();
    }
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled]);

  return <AdminRealtimeContext.Provider value={{ status, subscribe }}>{children}</AdminRealtimeContext.Provider>;
}

// Subscribes `handler` for the lifetime of the calling component. Safe to
// call from multiple components/pages at once (each gets every event --
// the gateway already scoped the whole stream to this admin's own broker,
// so there's nothing left for a page to filter beyond `event.type`).
export function useAdminEventStream(handler: Handler) {
  const ctx = useContext(AdminRealtimeContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe((event) => handlerRef.current(event));
  }, [ctx]);
}

// For a shell-level connection-status pill -- e.g. "reconnecting..." in
// the topbar. Returns "live" (never blocks rendering) if no provider is
// mounted, e.g. a page rendered outside the backoffice shell in tests.
export function useAdminConnectionStatus(): AdminConnectionStatus {
  const ctx = useContext(AdminRealtimeContext);
  return ctx?.status ?? "live";
}
