// App-level liveness for the gateway's WebSocket streams (2026-10-23).
//
// The browser's native WebSocket API never surfaces protocol-level
// ping/pong frames to JS, and a quiet event stream (no order activity for
// minutes) is indistinguishable from a dead one -- so liveness has to be
// plain application messages:
//   - the client sends {"type":"ping", t?} and gets {"type":"pong", t} back
//     (the price stream's hotfix/terminal-live-bugs #3 contract, now shared);
//   - a keepalive socket gets {"type":"keepalive"} once nothing has been
//     sent to it for KEEPALIVE_IDLE_MS, so a client watchdog can treat
//     "no frame in N seconds" as a dead connection on every stream.
//
// Keepalive is per socket, not per stream: the shipped terminal, WebTrader
// and mobile clients refetch orders/positions/account on ANY event type they
// don't recognise, so an unsolicited keepalive every 15 s would turn every
// open terminal into a poller. Those streams send it only to a client that
// asked for it (?keepalive=1, see wantsKeepalive).

import { WebSocket } from "ws";

export const KEEPALIVE_IDLE_MS = 15_000;
const KEEPALIVE_FRAME = JSON.stringify({ type: "keepalive" });

const keepaliveTimers = new WeakMap<WebSocket, NodeJS.Timeout>();

/** The upgrade URL's opt-in: `?keepalive=1`. */
export function wantsKeepalive(url: URL): boolean {
  return url.searchParams.get("keepalive") === "1";
}

/** Sends one frame to a client and restarts its keepalive idle clock (if it has one). */
export function sendFrame(ws: WebSocket, text: string): void {
  ws.send(text);
  keepaliveTimers.get(ws)?.refresh();
}

/** Answers {"type":"ping"} with {"type":"pong", t} (t echoed so the client can time the round trip). Anything else a
 * client sends is ignored, as before -- none of these streams expects other input. */
export function answerPings(ws: WebSocket): void {
  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed?.type === "ping") sendFrame(ws, JSON.stringify({ type: "pong", t: parsed.t }));
    } catch {
      // not a ping frame -- ignore it
    }
  });
}

/** {"type":"keepalive"} after idleMs with nothing sent, then every idleMs while it stays idle; every sendFrame
 * pushes the next one back. Stops on close / error. */
export function startKeepalive(ws: WebSocket, idleMs = KEEPALIVE_IDLE_MS): void {
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(KEEPALIVE_FRAME);
    } catch {
      // the socket's own close / error handlers clean up
    }
  }, idleMs);
  timer.unref?.();
  keepaliveTimers.set(ws, timer);
  const stop = () => {
    clearInterval(timer);
    keepaliveTimers.delete(ws);
  };
  ws.on("close", stop);
  ws.on("error", stop);
}
