"use client";

import { useEffect, useRef, useState } from "react";

export type LiveTick = { bid: number; ask: number; at: number };

const MAX_TICK_HZ_PER_SYMBOL = 20;

// Manager/Broker-Admin backoffice equivalent of WebTrader.tsx's own
// price-tick WebSocket effect -- same acceptCoalescedTick throttling (at
// most 20 updates/s per symbol, so a fast-ticking feed can't force more
// re-renders than a human-readable P/L display needs). Same gateway
// endpoint (services/api-gateway/src/ws.ts's attachPriceStream), which
// now also accepts an admin session there (prices are broker-agnostic
// public market data, not account-scoped -- see that file's own auth
// comment) instead of only a trader one, since this is the first
// backoffice consumer of it.
//
// No desktop-native-relay branch here -- manager-tauri/admin-tauri don't
// have one yet (unlike desktop-tauri's window.vyxDesktop.onPriceTick),
// so this is always a plain browser WebSocket, matching
// lib/admin-realtime.tsx's own precedent for this backoffice's other
// live stream.
export function useLiveTicks(): Record<string, LiveTick> {
  const [ticks, setTicks] = useState<Record<string, LiveTick>>({});
  const lastAcceptedAtRef = useRef<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const base = process.env.NEXT_PUBLIC_GATEWAY_WS_URL ?? "ws://127.0.0.1:8080";
      socket = new WebSocket(`${base}/v1/prices/stream`);
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string);
          const symbol = parsed?.symbol;
          const bid = Number(parsed?.bid);
          const ask = Number(parsed?.ask);
          if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
          const now = performance.now();
          const last = lastAcceptedAtRef.current[symbol] ?? 0;
          if (now - last < 1000 / MAX_TICK_HZ_PER_SYMBOL) return;
          lastAcceptedAtRef.current[symbol] = now;
          setTicks((prev) => ({ ...prev, [symbol]: { bid, ask, at: Date.now() } }));
        } catch {
          // malformed frame -- ignore, next tick corrects the picture
        }
      };
      socket.onclose = () => {
        if (!cancelled) reconnectTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => socket?.close();
    }
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return ticks;
}
