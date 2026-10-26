# Stub caddy for the caddy-rotate-secrets test (no real Caddy): adapts the "Caddyfile" from THIS process's environment,
# like {$VAR}. validate fails on an empty placeholder; reload writes the adapted config as the running one (FAIL_RELOAD=1:
# reload fails; IGNORE_PREV=1: the running config loses the PREVIOUS read value, so a price check goes wrong); adapt
# prints it. The adapted config is nested like a real one (apps / servers / routes) so key order and array order matter.
import json, os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
cmd = sys.argv[1]
cf = sys.argv[sys.argv.index("--config") + 1]
text = open(cf).read()
names = sorted(set(re.findall(r"\{\$([A-Za-z_][A-Za-z0-9_]*)\}", text)))
env = {n: os.environ.get(n, "") for n in names}
adapted = {
    "apps": {"http": {"servers": {"srv0": {
        "listen": [":443"],
        "routes": [
            {"match": [{"host": ["feed.example"]}], "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8081"}]}]},
            {"handle": [{"handler": "static_response", "status_code": 401}]},
        ],
    }}}},
    "read": env.get("MARKET_DATA_READ_SECRET", ""),
    "prev": env.get("MARKET_DATA_READ_SECRET_PREVIOUS", ""),
    "internal": env.get("INTERNAL_SERVICE_SECRET", ""),
}
if cmd == "validate":
    empty = [n for n in names if not env[n]]
    if empty:
        print("Error: empty placeholder(s) " + ",".join(empty)); sys.exit(1)
    print("Valid configuration"); sys.exit(0)
if cmd == "adapt":
    print(json.dumps(adapted)); sys.exit(0)
if cmd == "reload":
    if os.environ.get("FAIL_RELOAD") == "1":
        print("Error: reload refused"); sys.exit(1)
    if os.environ.get("IGNORE_PREV") == "1":
        adapted["prev"] = ""
    json.dump(adapted, open(os.path.join(here, "work", "running.json"), "w")); print("reloaded"); sys.exit(0)
sys.exit(2)
