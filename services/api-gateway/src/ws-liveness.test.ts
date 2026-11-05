import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import { answerPings, sendFrame, startKeepalive, wantsKeepalive } from "./ws-liveness.js";

const IDLE_MS = 300;
// the timer may fire a hair early against Date.now(); never a real idle period early
const CLOCK_SLACK_MS = 20;

type Frame = { at: number; msg: { type: string; t?: unknown; seq?: number } };
type Pair = { client: WebSocket; server: WebSocket; frames: Frame[]; close: () => Promise<void> };

// one real server + client pair; `setup` wires the server-side socket the way ws.ts does
async function pair(setup: (ws: WebSocket) => void): Promise<Pair> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const serverSide = new Promise<WebSocket>((resolve) => wss.on("connection", (ws) => { setup(ws); resolve(ws); }));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const frames: Frame[] = [];
  client.on("message", (d) => frames.push({ at: Date.now(), msg: JSON.parse(d.toString()) }));
  await new Promise((r) => client.once("open", r));
  const server = await serverSide;
  return {
    client,
    server,
    frames,
    // terminate, not close: a closing handshake that never finishes would leave http.close waiting forever
    close: async () => {
      client.terminate();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}

// a failed assertion must still close the pair: an open server keeps the test process alive and the run hangs
async function withPair(setup: (ws: WebSocket) => void, body: (p: Pair) => Promise<void>): Promise<void> {
  const p = await pair(setup);
  try {
    await body(p);
  } finally {
    await p.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// waits for the condition, not for a guessed time: a slow machine only makes the test take longer
async function waitFor(done: () => boolean, what: string, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

test("ping is answered with pong echoing t", async () => {
  await withPair((ws) => answerPings(ws), async (p) => {
    p.client.send(JSON.stringify({ type: "ping", t: 42 }));
    p.client.send("not json");
    p.client.send(JSON.stringify({ type: "hello" }));
    p.client.send(JSON.stringify({ type: "ping", t: 43 }));
    await waitFor(() => p.frames.length >= 2, "both pongs");
    assert.deepEqual(p.frames.map((f) => f.msg), [{ type: "pong", t: 42 }, { type: "pong", t: 43 }]);
  });
});

test("an idle keepalive socket gets {type: keepalive} every idle period", async () => {
  const start = Date.now();
  await withPair((ws) => startKeepalive(ws, IDLE_MS), async (p) => {
    await waitFor(() => p.frames.length >= 3, "three keepalives");
    assert.ok(p.frames.every((f) => f.msg.type === "keepalive"));
    // lower bounds only: a late timer is harmless, an early one is the bug
    p.frames.slice(0, 3).forEach((f, i) => {
      assert.ok(f.at - start >= IDLE_MS * (i + 1) - CLOCK_SLACK_MS, `keepalive ${i + 1} only after ${i + 1} idle periods`);
    });
  });
});

test("traffic pushes the keepalive back: none within an idle period of an event, one after they stop", async () => {
  await withPair((ws) => startKeepalive(ws, IDLE_MS), async (p) => {
    const sentAt: number[] = [];
    for (let seq = 0; seq < 6; seq++) {
      sentAt.push(Date.now());
      sendFrame(p.server, JSON.stringify({ type: "OrderFilled", seq }));
      await sleep(IDLE_MS / 2);
    }
    const isLast = (f: Frame) => f.msg.seq === sentAt.length - 1;
    await waitFor(() => p.frames.some(isLast), "the last event");
    const lastIndex = p.frames.findIndex(isLast);
    await waitFor(() => p.frames.slice(lastIndex).some((f) => f.msg.type === "keepalive"), "the keepalive after the events");

    // A stalled loop can sleep past an idle period, and then a keepalive is correct. So the rule is checked per
    // keepalive: it must come a full idle period after the event sent just before it. Frames arrive in send order.
    let lastSeq = -1;
    let keepalives = 0;
    for (const f of p.frames) {
      if (f.msg.type !== "keepalive") {
        lastSeq = f.msg.seq as number;
        continue;
      }
      keepalives++;
      if (lastSeq >= 0) assert.ok(f.at - sentAt[lastSeq] >= IDLE_MS - CLOCK_SLACK_MS, `keepalive came too soon after event ${lastSeq}`);
    }
    assert.ok(keepalives >= 1);
  });
});

test("a pong is traffic too, and a socket without keepalive never gets one", async () => {
  await withPair((ws) => answerPings(ws), async (p) => {
    await sleep(IDLE_MS * 2);
    assert.equal(p.frames.length, 0);
  });
});

test("keepalive stops when the client goes away", async () => {
  const p = await pair((ws) => startKeepalive(ws, IDLE_MS));
  let sends = 0;
  const realSend = p.server.send.bind(p.server);
  p.server.send = ((...args: Parameters<WebSocket["send"]>) => { sends++; return realSend(...args); }) as WebSocket["send"];
  await p.close();
  await sleep(IDLE_MS * 2);
  assert.equal(sends, 0);
});

test("opt-in is ?keepalive=1 only", () => {
  assert.equal(wantsKeepalive(new URL("http://x/v1/trading/stream?ticket=a&keepalive=1")), true);
  assert.equal(wantsKeepalive(new URL("http://x/v1/trading/stream?ticket=a")), false);
  assert.equal(wantsKeepalive(new URL("http://x/v1/trading/stream?keepalive=true")), false);
});
