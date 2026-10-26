# Stand-in for feed.vyxtrader.com and Caddy's admin endpoint, for the caddy-rotate-secrets test.
# Prices check X-Market-Data-Secret against the RUNNING config. /config/ returns the running config the way Caddy's
# admin endpoint does: the same content, but its OWN key order (here: every object's keys reversed, at every depth).
# work/swap-array.flag present: the routes array comes back in another order too (a real difference: routes are ordered).
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")


def reorder(o, swap_arrays):
    if isinstance(o, dict):
        return {k: reorder(o[k], swap_arrays) for k in reversed(list(o.keys()))}
    if isinstance(o, list):
        items = [reorder(x, swap_arrays) for x in o]
        return list(reversed(items)) if swap_arrays else items
    return o


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body=b"", ctype=None):
        self.send_response(code)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            cfg = json.load(open(os.path.join(WORK, "running.json")))
        except Exception:
            cfg = {}
        if self.path == "/config/":
            swap = os.path.exists(os.path.join(WORK, "swap-array.flag"))
            return self.send(200, json.dumps(reorder(cfg, swap)).encode(), "application/json")
        if self.path == "/health":
            return self.send(200, b"ok")
        if self.path.startswith("/internal/prices/"):
            got = self.headers.get("X-Market-Data-Secret")
            allowed = {v for v in (cfg.get("read"), cfg.get("prev")) if v}
            return self.send(200 if got and got in allowed else 401)
        self.send(404)


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
