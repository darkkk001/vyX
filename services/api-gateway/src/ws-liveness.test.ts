import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import { answerPings, sendFrame, startKeepalive, wantsKeepalive } from "./ws-liveness.js";

const IDLE_MS = 300;

// one real server + client pair; `setup` wires the server-side socket the way ws.ts does
async function pair(setup: (ws: WebSocket) => void): Promise<{ client: WebSocket; server: WebSocket; frames: { at: number; msg: { type: string; t?: unknown } }[]; close: () => Promise<void> }> {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const serverSide = new Promise<WebSocket>((resolve) => wss.on("connection", (ws) => { setup(ws); resolve(ws); }));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const frames: { at: number; msg: { type: string; t?: unknown } }[] = [];
  client.on("message", (d) => frames.push({ at: Date.now(), msg: JSON.parse(d.toString()) }));
  await new Promise((r) => client.once("open", r));
  const server = await serverSide;
  return {
    client,
    server,
    frames,
    close: async () => {
      client.close();
      wss.close();
      await new Promise((r) => http.close(r));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("ping is answered with pong echoing t", async () => {
  const p = await pair((ws) => answerPings(ws));
  p.client.send(JSON.stringify({ type: "ping", t: 42 }));
  p.client.send("not json");
  p.client.send(JSON.stringify({ type: "hello" }));
  await sleep(100);
  assert.deepEqual(p.frames.map((f) => f.msg), [{ type: "pong", t: 42 }]);
  await p.close();
});

test("an idle keepalive socket gets {type: keepalive} every idle period", async () => {
  const start = Date.now();
  const p = await pair((ws) => startKeepalive(ws, IDLE_MS));
  await sleep(IDLE_MS * 3 + 150);
  const keepalives = p.frames.filter((f) => f.msg.type === "keepalive");
  assert.equal(keepalives.length, 3);
  assert.ok(keepalives[0].at - start >= IDLE_MS - 20, "first keepalive only after a full idle period");
  await p.close();
});

test("traffic pushes the keepalive back: none while events flow, one after they stop", async () => {
  const p = await pair((ws) => startKeepalive(ws, IDLE_MS));
  for (let i = 0; i < 6; i++) {
    sendFrame(p.server, JSON.stringify({ type: "OrderFilled" }));
    await sleep(IDLE_MS / 2);
  }
  assert.equal(p.frames.filter((f) => f.msg.type === "keepalive").length, 0, "no keepalive while events arrive every half period");
  const lastEvent = p.frames[p.frames.length - 1].at;
  await sleep(IDLE_MS + 150);
  const keepalives = p.frames.filter((f) => f.msg.type === "keepalive");
  assert.equal(keepalives.length, 1);
  assert.ok(keepalives[0].at - lastEvent >= IDLE_MS - 20, "keepalive counts from the last event");
  await p.close();
});

test("a pong is traffic too, and a socket without keepalive never gets one", async () => {
  const p = await pair((ws) => answerPings(ws));
  await sleep(IDLE_MS * 2);
  assert.equal(p.frames.length, 0);
  await p.close();
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
