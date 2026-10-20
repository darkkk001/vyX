// One cTrader FIX 4.4 QUOTE session with reconnect: Logon (ResetSeqNumFlag=Y on every connect, so both sides
// restart at 1), Heartbeat/TestRequest liveness, inbound sequence checks, SecurityListRequest to resolve symbol
// names to cTrader's numeric Symbol(55) ids, one MarketDataRequest per symbol (top of book, incremental updates),
// and top-of-book reconstruction from 35=W snapshots and 35=X incremental refreshes.

import net from "node:net";
import tls from "node:tls";
import { decode, encode, fixTime, FixStreamParser, parseFixTime, redact, type Field, type FixMessage } from "./fix.ts";
import type { Config } from "./config.ts";

export interface Quote {
  name: string;          // cTrader symbol name
  bid?: number;
  ask?: number;
  serverMs?: number;     // SendingTime(52) of the message that carried it, UTC ms
}

export interface SessionHandlers {
  onQuote(q: Quote): void;
  onLog(line: string): void;
  onLoggedOn?(): void;
  onDisconnected?(reason: string): void;
  // Called once when cfg.maxLogonFailures consecutive logons failed; the session has stopped reconnecting.
  onGaveUp?(reason: string): void;
}

export interface SessionCounters {
  connects: number;
  logons: number;
  disconnects: number;
  inboundSeqGaps: number;
  inboundSeqGapMessages: number;
  resendRequestsReceived: number;
  sequenceResets: number;
  testRequestsSent: number;
  testRequestsReceived: number;
  rejects: number;
  mdRejects: number;
  badMessages: number;
}

interface BookEntry { side: "0" | "1"; price: number }

const LOGON_TIMEOUT_MS = 15_000;
const SECURITY_LIST_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const STABLE_SESSION_MS = 60_000;

export class QuoteSession {
  readonly counters: SessionCounters = {
    connects: 0, logons: 0, disconnects: 0, inboundSeqGaps: 0, inboundSeqGapMessages: 0, resendRequestsReceived: 0,
    sequenceResets: 0, testRequestsSent: 0, testRequestsReceived: 0, rejects: 0, mdRejects: 0, badMessages: 0,
  };

  private readonly cfg: Config;
  private readonly h: SessionHandlers;
  private sock: net.Socket | null = null;
  private outSeq = 1;
  private inExpected = 1;
  private loggedOn = false;
  private loggedOnAt = 0;
  private lastSentMs = 0;
  private lastRecvMs = 0;
  private testReqPendingSince = 0;
  private testReqId = "";
  private timer: NodeJS.Timeout | null = null;
  private logonTimer: NodeJS.Timeout | null = null;
  private secListTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private logonFailures = 0;
  private stopping = false;
  private closedReason = "";
  private reqCounter = 0;

  private readonly idByName = new Map<string, string>();
  private readonly nameById = new Map<string, string>();
  private readonly books = new Map<string, Map<string, BookEntry>>();
  private subscribed = false;

  constructor(cfg: Config, handlers: SessionHandlers) {
    this.cfg = cfg;
    this.h = handlers;
    for (const [name, id] of Object.entries(cfg.symbolIds)) this.setId(name, id);
  }

  start(): void {
    this.stopping = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock && this.loggedOn) {
      this.send([[35, "5"], [58, "client shutdown"]]);
      await new Promise((r) => setTimeout(r, 1500));
    }
    this.teardown("stopped");
  }

  private log(line: string): void {
    this.h.onLog(line);
  }

  private setId(name: string, id: string): void {
    this.idByName.set(name, id);
    this.nameById.set(id, name);
  }

  private connect(): void {
    const { host, port, ssl } = this.cfg;
    this.counters.connects++;
    this.outSeq = 1;
    this.inExpected = 1;
    this.loggedOn = false;
    this.subscribed = false;
    this.books.clear();
    this.closedReason = "";
    this.testReqPendingSince = 0;
    this.log(`connecting ${ssl ? "ssl" : "tcp"}://${host}:${port} (attempt ${this.attempt + 1})`);

    const parser = new FixStreamParser((reason) => {
      this.counters.badMessages++;
      this.log(`inbound framing: ${reason}`);
    });
    const sock = ssl ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);

    sock.once(ssl ? "secureConnect" : "connect", () => {
      this.log(`connected${ssl ? ` (${(sock as tls.TLSSocket).getProtocol?.() ?? "tls"})` : ""}, sending Logon`);
      this.lastRecvMs = Date.now();
      this.send([
        [35, "A"], [98, "0"], [108, String(this.cfg.heartbeatSec)], [141, "Y"],
        [553, this.cfg.username], [554, this.cfg.password],
      ]);
      this.logonTimer = setTimeout(() => this.drop("no Logon reply within 15s"), LOGON_TIMEOUT_MS);
      this.timer = setInterval(() => this.tick(), 1000);
    });
    sock.on("data", (chunk: Buffer) => {
      for (const raw of parser.push(chunk)) this.onMessage(raw);
    });
    sock.on("error", (err) => {
      this.closedReason ||= `socket error: ${err.message}`;
    });
    sock.on("close", () => {
      this.teardown(this.closedReason || "connection closed by peer");
    });
  }

  private teardown(reason: string): void {
    if (this.timer) clearInterval(this.timer);
    if (this.logonTimer) clearTimeout(this.logonTimer);
    if (this.secListTimer) clearTimeout(this.secListTimer);
    this.timer = this.logonTimer = this.secListTimer = null;
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    sock.removeAllListeners("close");
    sock.on("error", () => {});
    sock.destroy();
    const wasOn = this.loggedOn;
    this.loggedOn = false;
    this.counters.disconnects++;
    this.log(`disconnected: ${reason}`);
    this.h.onDisconnected?.(reason);
    if (this.stopping) return;
    // Repeated bad logons can lock the account on cTrader, so a run of them stops the session instead of retrying.
    if (!wasOn) {
      this.logonFailures++;
      if (this.cfg.maxLogonFailures > 0 && this.logonFailures >= this.cfg.maxLogonFailures) {
        this.stopping = true;
        this.log(`giving up after ${this.logonFailures} failed logons in a row (FIX_MAX_LOGON_FAILURES=${this.cfg.maxLogonFailures})`);
        this.h.onGaveUp?.(reason);
        return;
      }
    }
    if (wasOn && Date.now() - this.loggedOnAt >= STABLE_SESSION_MS) this.attempt = 0;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = Math.round(base * (1 + Math.random() * 0.2));
    this.attempt++;
    this.log(`reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private drop(reason: string): void {
    this.closedReason = reason;
    this.teardown(reason);
  }

  private send(body: Field[], seqOverride?: number, possDup = false): void {
    if (!this.sock) return;
    const seq = seqOverride ?? this.outSeq++;
    const header: Field[] = [
      body[0],
      [49, this.cfg.senderCompId], [56, this.cfg.targetCompId], [34, String(seq)], [52, fixTime()],
      [50, this.cfg.senderSubId], [57, this.cfg.targetSubId],
    ];
    if (possDup) header.push([43, "Y"]);
    const raw = encode([...header, ...body.slice(1)]);
    if (body[0][1] !== "0" && body[0][1] !== "V") this.log(`> ${redact(raw)}`);
    this.sock.write(raw, "latin1");
    this.lastSentMs = Date.now();
  }

  private tick(): void {
    if (!this.sock) return;
    const now = Date.now();
    const hbMs = this.cfg.heartbeatSec * 1000;
    if (this.loggedOn && now - this.lastSentMs >= hbMs) this.send([[35, "0"]]);
    if (!this.loggedOn) return;
    if (this.testReqPendingSince) {
      if (now - this.testReqPendingSince > hbMs) this.drop(`no reply to TestRequest within ${this.cfg.heartbeatSec}s`);
      return;
    }
    if (now - this.lastRecvMs > hbMs + 2000) {
      this.testReqId = `TR-${now}`;
      this.testReqPendingSince = now;
      this.counters.testRequestsSent++;
      this.log(`nothing received for ${Math.round((now - this.lastRecvMs) / 1000)}s, sending TestRequest`);
      this.send([[35, "1"], [112, this.testReqId]]);
    }
  }

  private onMessage(raw: string): void {
    this.lastRecvMs = Date.now();
    const m = decode(raw);
    const seq = Number(m.get(34));
    const possDup = m.get(43) === "Y";

    if (m.type === "4" && m.get(123) !== "Y") {
      // SequenceReset-Reset: ignores MsgSeqNum by definition.
      this.counters.sequenceResets++;
      const next = Number(m.get(36));
      this.log(`< SequenceReset to ${next} (expected ${this.inExpected})`);
      if (next >= this.inExpected) this.inExpected = next;
      return;
    }

    if (Number.isInteger(seq)) {
      if (seq < this.inExpected) {
        if (possDup) return; // a resend of something already processed
        if (m.type === "A" && m.get(141) === "Y") this.inExpected = seq;
        else {
          this.log(`< MsgSeqNum ${seq} lower than expected ${this.inExpected} without PossDupFlag, resetting the session`);
          this.send([[35, "5"], [58, `MsgSeqNum too low, expecting ${this.inExpected} but received ${seq}`]]);
          this.drop("inbound sequence too low");
          return;
        }
      } else if (seq > this.inExpected && m.type !== "A") {
        const missing = seq - this.inExpected;
        this.counters.inboundSeqGaps++;
        this.counters.inboundSeqGapMessages += missing;
        this.log(`< sequence gap: expected ${this.inExpected}, got ${seq} (${missing} missing), sending ResendRequest`);
        this.send([[35, "2"], [7, String(this.inExpected)], [16, "0"]]);
      }
      this.inExpected = seq + 1;
    }

    switch (m.type) {
      case "W": return this.onSnapshot(m);
      case "X": return this.onIncremental(m);
      case "0":
        if (this.testReqPendingSince && m.get(112) === this.testReqId) {
          this.log(`< Heartbeat answering TestRequest after ${Date.now() - this.testReqPendingSince}ms`);
          this.testReqPendingSince = 0;
        }
        return;
      case "A": return this.onLogon(m);
      case "1":
        this.counters.testRequestsReceived++;
        this.send([[35, "0"], [112, m.get(112) ?? ""]]);
        return;
      case "2": {
        // We never resend quote-session traffic (stale requests would be wrong); gap-fill the whole range.
        this.counters.resendRequestsReceived++;
        const begin = Number(m.get(7));
        this.log(`< ResendRequest ${begin}..${m.get(16)}, answering with SequenceReset-GapFill to ${this.outSeq}`);
        this.send([[35, "4"], [123, "Y"], [36, String(this.outSeq)]], begin, true);
        return;
      }
      case "4":
        this.log(`< SequenceReset-GapFill to ${m.get(36)}`);
        if (Number(m.get(36)) > this.inExpected) this.inExpected = Number(m.get(36));
        return;
      case "3":
        this.counters.rejects++;
        this.log(`< Reject ref seq ${m.get(45)} tag ${m.get(371) ?? "-"} reason ${m.get(373) ?? "-"}: ${m.get(58) ?? ""}`);
        return;
      case "j":
        this.counters.rejects++;
        this.log(`< BusinessMessageReject ref ${m.get(372)} reason ${m.get(380)}: ${m.get(58) ?? ""}`);
        if (m.get(372) === "x") this.securityListUnavailable("BusinessMessageReject");
        return;
      case "Y":
        this.counters.mdRejects++;
        this.log(`< MarketDataRequestReject ${m.get(262)} reason ${m.get(281) ?? "-"}: ${m.get(58) ?? ""}`);
        return;
      case "y": return this.onSecurityList(m);
      case "5":
        this.log(`< Logout: ${m.get(58) ?? "(no text)"}`);
        if (!this.stopping) this.send([[35, "5"]]);
        this.drop(`server Logout: ${m.get(58) ?? "(no text)"}`);
        return;
      default:
        this.log(`< unhandled 35=${m.type}: ${redact(raw)}`);
    }
  }

  private onLogon(m: FixMessage): void {
    if (this.logonTimer) clearTimeout(this.logonTimer);
    this.logonTimer = null;
    this.loggedOn = true;
    this.loggedOnAt = Date.now();
    this.counters.logons++;
    this.logonFailures = 0;
    this.log(`< Logon accepted, HeartBtInt ${m.get(108)}s, seq reset ${m.get(141) === "Y" ? "Y" : "N"}`);
    this.h.onLoggedOn?.();
    if (this.cfg.symbols.every((s) => this.idByName.has(s))) {
      this.subscribeAll();
      return;
    }
    this.send([[35, "x"], [320, `SL-${++this.reqCounter}`], [559, "0"]]);
    this.secListTimer = setTimeout(() => this.securityListUnavailable("no SecurityList within 15s"), SECURITY_LIST_TIMEOUT_MS);
  }

  private onSecurityList(m: FixMessage): void {
    let id: string | undefined;
    let count = 0;
    for (const [tag, value] of m.fields) {
      if (tag === 55) id = value;
      else if (tag === 1007 && id !== undefined) {
        // Ids set by hand (FIX_SYMBOL_IDS) win over the server list.
        if (!this.cfg.symbolIds[value]) this.setId(value, id);
        id = undefined;
        count++;
      }
    }
    this.log(`< SecurityList: ${count} symbols${m.get(893) === "N" ? " (more fragments follow)" : ""}`);
    if (m.get(893) === "N") return;
    if (this.secListTimer) clearTimeout(this.secListTimer);
    this.secListTimer = null;
    this.subscribeAll();
  }

  private securityListUnavailable(why: string): void {
    if (this.secListTimer) clearTimeout(this.secListTimer);
    this.secListTimer = null;
    if (this.subscribed) return;
    this.log(`SecurityList unavailable (${why}); subscribing only the symbols with FIX_SYMBOL_IDS`);
    this.subscribeAll();
  }

  private subscribeAll(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    const missing = this.cfg.symbols.filter((s) => !this.idByName.has(s));
    if (missing.length) this.log(`no cTrader symbol id for ${missing.join(",")}; not subscribed (set FIX_SYMBOL_IDS or fix FIX_SYMBOLS)`);
    for (const name of this.cfg.symbols) {
      const id = this.idByName.get(name);
      if (!id) continue;
      this.send([
        [35, "V"], [262, `MD-${name}-${++this.reqCounter}`], [263, "1"], [264, "1"], [265, "1"],
        [267, "2"], [269, "0"], [269, "1"], [146, "1"], [55, id],
      ]);
      this.log(`> MarketDataRequest ${name} (id ${id}) top of book, incremental`);
    }
  }

  // 35=W: full refresh for one symbol (55 in the header part). Entries start at each 269.
  private onSnapshot(m: FixMessage): void {
    const id = m.get(55);
    const name = id ? this.nameById.get(id) : undefined;
    if (!id || !name) return;
    const book = new Map<string, BookEntry>();
    let side: "0" | "1" | undefined;
    let entryId: string | undefined;
    let price: number | undefined;
    const flush = () => {
      if (side && price !== undefined) book.set(entryId ?? `s${side}`, { side, price });
      side = undefined; entryId = undefined; price = undefined;
    };
    let inGroup = false;
    for (const [tag, value] of m.fields) {
      if (tag === 268) { inGroup = true; continue; }
      if (!inGroup) continue;
      if (tag === 269) { flush(); side = value === "0" || value === "1" ? value : undefined; }
      else if (tag === 278) entryId = value;
      else if (tag === 270) price = Number(value);
    }
    flush();
    this.books.set(id, book);
    this.emit(id, name, parseFixTime(m.get(52)));
  }

  // 35=X: each entry starts at 279 and names its own symbol (55).
  private onIncremental(m: FixMessage): void {
    const touched = new Set<string>();
    let action: string | undefined, side: "0" | "1" | undefined, entryId: string | undefined, sym: string | undefined, price: number | undefined;
    const flush = () => {
      if (action !== undefined && sym) {
        let book = this.books.get(sym);
        if (!book) this.books.set(sym, (book = new Map()));
        const key = entryId ?? (side ? `s${side}` : "");
        if (action === "2") { if (key) book.delete(key); }
        else if (side && price !== undefined && key) book.set(key, { side, price });
        touched.add(sym);
      }
      action = side = entryId = sym = price = undefined;
    };
    for (const [tag, value] of m.fields) {
      if (tag === 279) { flush(); action = value; }
      else if (action === undefined) continue;
      else if (tag === 269) side = value === "0" || value === "1" ? value : undefined;
      else if (tag === 278) entryId = value;
      else if (tag === 55) sym = value;
      else if (tag === 270) price = Number(value);
    }
    flush();
    const serverMs = parseFixTime(m.get(52));
    for (const id of touched) {
      const name = this.nameById.get(id);
      if (name) this.emit(id, name, serverMs);
    }
  }

  private emit(id: string, name: string, serverMs: number | undefined): void {
    const book = this.books.get(id);
    if (!book) return;
    let bid: number | undefined, ask: number | undefined;
    for (const e of book.values()) {
      if (e.side === "0" && (bid === undefined || e.price > bid)) bid = e.price;
      if (e.side === "1" && (ask === undefined || e.price < ask)) ask = e.price;
    }
    this.h.onQuote({ name, bid, ask, serverMs });
  }
}
