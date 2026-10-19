import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { checksum, decode, encode, fixTime, FixStreamParser, parseFixTime, redact, SOH, type Field } from "./fix.ts";
import { loadConfig, type Config } from "./config.ts";
import { brokerOffsetSec } from "./offset.ts";
import { QuoteSession, type Quote } from "./session.ts";
import { TickSink } from "./sink.ts";

test("encode produces correct BodyLength and CheckSum", () => {
  const raw = encode([[35, "0"], [49, "A"], [56, "B"], [34, "1"], [52, "20260101-00:00:00.000"]]);
  const inner = raw.slice(raw.indexOf(`${SOH}35=`) + 1, raw.indexOf(`${SOH}10=`) + 1);
  assert.equal(Number(/9=(\d+)/.exec(raw)![1]), inner.length);
  const ck = raw.slice(raw.lastIndexOf("10=") + 3, -1);
  assert.equal(ck, checksum(raw.slice(0, raw.lastIndexOf("10="))));
});

test("parser splits a stream across chunk boundaries and drops a bad checksum", () => {
  const a = encode([[35, "0"], [34, "1"]]);
  const b = encode([[35, "1"], [34, "2"], [112, "x"]]);
  const bad = a.replace(/10=\d{3}/, "10=000");
  const errors: string[] = [];
  const p = new FixStreamParser((e) => errors.push(e));
  const all = a + bad + b;
  const got: string[] = [];
  for (let i = 0; i < all.length; i += 7) got.push(...p.push(all.slice(i, i + 7)));
  assert.deepEqual(got.map((r) => decode(r).type), ["0", "1"]);
  assert.equal(errors.length, 1);
});

test("time helpers round-trip and redact hides the password", () => {
  const ms = Date.UTC(2026, 9, 20, 13, 4, 5, 67);
  assert.equal(fixTime(ms), "20261020-13:04:05.067");
  assert.equal(parseFixTime("20261020-13:04:05.067"), ms);
  assert.equal(parseFixTime("20261020-13:04:05"), ms - 67);
  assert.ok(!redact(encode([[35, "A"], [554, "hunter2"]])).includes("hunter2"));
});

test("broker offset follows New York close (UTC+3 in US summer time, UTC+2 in winter)", () => {
  assert.equal(brokerOffsetSec(Date.UTC(2026, 6, 1)), 3 * 3600);
  assert.equal(brokerOffsetSec(Date.UTC(2026, 0, 15)), 2 * 3600);
});

function cfgFor(port: number, extra: Record<string, string> = {}): Config {
  return loadConfig({
    FIX_HOST: "127.0.0.1", FIX_PORT: String(port), FIX_SSL: "false",
    FIX_SENDER_COMP_ID: "demo.test.123456", FIX_PASSWORD: "pw", FIX_HEARTBEAT_SEC: "2",
    FIX_SYMBOLS: "XAUUSD,USTEC", BROKER_OFFSET_SEC: "10800", ...extra,
  });
}

test("sink body matches the EA's tick JSON and only resends changes between snapshots", () => {
  const sink = new TickSink(cfgFor(1), () => {});
  sink.update("XAUUSD", 2650.1, 2650.3, 1_000);
  const first = JSON.parse(sink.buildBody(10_000)!);
  assert.deepEqual(Object.keys(first[0]), ["symbol", "bid", "ask", "t0", "tick_ms", "broker_offset_sec"]);
  assert.deepEqual(first[0], { symbol: "XAUUSD", bid: 2650.1, ask: 2650.3, t0: 10_000, tick_ms: 1_000, broker_offset_sec: 10800 });
  assert.equal(sink.buildBody(10_050), null);
  sink.update("NAS100", 20000, 20001, 1_100);
  assert.equal(JSON.parse(sink.buildBody(10_100)!).length, 1);
  assert.equal(JSON.parse(sink.buildBody(15_000)!).length, 2); // 5s snapshot
  assert.match(sink.buildBody(20_000)!, /"bid":2650\.10000,/);
});

// A minimal cTrader QUOTE server: answers Logon, SecurityList, MarketDataRequest; the test drives the rest.
function fakeServer(onClient: (send: (body: Field[], seq?: number) => void, msgs: ReturnType<typeof decode>[], sock: net.Socket) => void) {
  return net.createServer((sock) => {
    let seq = 1;
    const msgs: ReturnType<typeof decode>[] = [];
    const send = (body: Field[], s?: number) => sock.write(encode([body[0], [49, "cServer"], [56, "demo.test.123456"], [34, String(s ?? seq++)], [52, fixTime()], ...body.slice(1)]), "latin1");
    const p = new FixStreamParser();
    sock.on("data", (c) => {
      for (const raw of p.push(c)) {
        const m = decode(raw);
        msgs.push(m);
        if (m.type === "A") send([[35, "A"], [98, "0"], [108, m.get(108)!], [141, "Y"]]);
        if (m.type === "x") send([[35, "y"], [320, m.get(320)!], [560, "0"], [146, "3"], [55, "1"], [1007, "EURUSD"], [55, "41"], [1007, "XAUUSD"], [55, "500"], [1007, "USTEC"]]);
      }
    });
    sock.on("error", () => {});
    onClient(send, msgs, sock);
  });
}

test("session: logon, symbol resolution, W snapshot + X incremental top of book, TestRequest, gap, reconnect", async () => {
  const quotes: Quote[] = [];
  const logs: string[] = [];
  let clients = 0;
  let firstSend!: (body: Field[], seq?: number) => void;
  let firstMsgs!: ReturnType<typeof decode>[];
  let firstSock!: net.Socket;
  const srv = fakeServer((send, msgs, sock) => {
    clients++;
    if (clients === 1) { firstSend = send; firstMsgs = msgs; firstSock = sock; }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  const session = new QuoteSession(cfgFor(port), { onQuote: (q) => quotes.push(q), onLog: (l) => logs.push(l) });
  session.start();
  const until = async (cond: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error(`timeout; log:\n${logs.join("\n")}`); await new Promise((r) => setTimeout(r, 20)); }
  };

  await until(() => (firstMsgs?.filter((m) => m.type === "V").length ?? 0) === 2);
  const logon = firstMsgs.find((m) => m.type === "A")!;
  assert.equal(logon.get(553), "123456");
  assert.equal(logon.get(141), "Y");
  assert.equal(logon.get(50), "QUOTE");
  assert.equal(logon.get(57), "QUOTE");
  const v = firstMsgs.find((m) => m.type === "V" && m.get(55) === "41")!;
  assert.equal(v.get(264), "1");
  assert.equal(v.get(265), "1");

  firstSend([[35, "W"], [262, "x"], [55, "41"], [268, "2"], [269, "0"], [270, "2650.11"], [269, "1"], [270, "2650.31"]]);
  await until(() => quotes.length === 1);
  assert.deepEqual({ ...quotes[0], serverMs: undefined }, { name: "XAUUSD", bid: 2650.11, ask: 2650.31, serverMs: undefined });
  assert.ok(typeof quotes[0].serverMs === "number");

  firstSend([[35, "X"], [262, "x"], [268, "1"], [279, "0"], [269, "1"], [278, "a1"], [55, "41"], [270, "2650.25"]]);
  await until(() => quotes.length === 2);
  assert.equal(quotes[1].ask, 2650.25);
  assert.equal(quotes[1].bid, 2650.11);

  // Server TestRequest -> Heartbeat with the same TestReqID
  firstSend([[35, "1"], [112, "PING"]]);
  await until(() => firstMsgs.some((m) => m.type === "0" && m.get(112) === "PING"));

  // Inbound gap: skip 5 sequence numbers -> ResendRequest from the client, quote still applied
  firstSend([[35, "W"], [262, "x"], [55, "500"], [268, "2"], [269, "0"], [270, "20000.5"], [269, "1"], [270, "20001.5"]], 50);
  await until(() => firstMsgs.some((m) => m.type === "2"));
  assert.equal(session.counters.inboundSeqGaps, 1);
  await until(() => quotes.some((q) => q.name === "USTEC"));

  // Server Logout -> client reconnects and logs on again with a fresh sequence
  firstSend([[35, "5"], [58, "test logout"]], 51);
  firstSock.end();
  await until(() => clients === 2 && session.counters.logons === 2, 8000);
  await session.stop();
  srv.close();
  assert.ok(logs.some((l) => l.includes("server Logout: test logout")));
});
