// Local-only: a TCP proxy in front of the scratch Postgres that delays every chunk by DELAY_MS in each direction,
// so one query round trip costs ~2 x DELAY_MS -- the ~6.5 ms Vercel fra1 -> Neon eu-central-1 round trip measured in
// production (docs/audit/2026-09-24/latency-breakdown.md). Also counts SQL statements (Parse / simple Query messages).
//   node scripts/e2e/pg-latency-proxy.mjs [listenPort=5599] [target=127.0.0.1:5499] [delayMs=3.25]
import net from "node:net";

const listenPort = Number(process.argv[2] ?? 5599);
const [host, port] = (process.argv[3] ?? "127.0.0.1:5499").split(":");
const delayMs = Number(process.argv[4] ?? 3.25);
let statements = 0;

function delayedPipe(from, to, onChunk) {
  const queue = [];
  let busy = false;
  // setImmediate spin, not setTimeout: Windows timers tick at ~15.6 ms, which would turn a 3.25 ms delay into ~16 ms
  const pump = () => {
    if (busy || queue.length === 0) return;
    busy = true;
    const spin = () => {
      while (queue.length > 0 && queue[0].due <= performance.now()) {
        const { chunk } = queue.shift();
        if (!to.destroyed) to.write(chunk);
      }
      if (queue.length > 0) setImmediate(spin);
      else busy = false;
    };
    setImmediate(spin);
  };
  from.on("data", (chunk) => {
    if (onChunk) onChunk(chunk);
    queue.push({ chunk, due: performance.now() + delayMs });
    pump();
  });
  from.on("close", () => to.destroy());
  from.on("error", () => to.destroy());
}

// Count frontend messages B (Bind) and Q (simple Query) -- one per executed SQL statement.
function counter() {
  let buf = Buffer.alloc(0);
  let started = false;
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        if (buf.length < 4) return;
        const len = buf.readInt32BE(0);
        if (buf.length < len) return;
        const code = buf.readInt32BE(4);
        buf = buf.subarray(len);
        if (code !== 80877103 && code !== 80877104) started = true; // SSL / GSS request, then the startup: no type byte
        continue;
      }
      if (buf.length < 5) return;
      const type = String.fromCharCode(buf[0]);
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) return;
      if (type === "B" || type === "Q") statements++; // Bind: one per executed statement, prepared-statement cache or not
      buf = buf.subarray(1 + len);
    }
  };
}

net
  .createServer((client) => {
    const server = net.connect(Number(port), host);
    delayedPipe(client, server, counter());
    delayedPipe(server, client);
  })
  .listen(listenPort, "127.0.0.1", () => console.log(`pg latency proxy :${listenPort} -> ${host}:${port}, +${delayMs} ms each way`));

// statement counter, read by the bench over a tiny HTTP-free TCP port (listenPort + 1): "get" / "reset"
net
  .createServer((s) => {
    s.on("data", (d) => {
      const cmd = d.toString().trim();
      if (cmd === "reset") statements = 0;
      s.end(String(statements));
    });
  })
  .listen(listenPort + 1, "127.0.0.1");
