"""Sounds v2 final set (owner 2026-10-23, A/B audition): variant A of every event, 44.1 kHz mono 16-bit, peak -6 dBFS.
The synthesis below is the owner's audition generator unchanged except SR (22050 -> 44100); B is kept for reference only.
generate-v1.py is the earlier 16-sound audition pack."""
import numpy as np, wave, base64, json, os
SR = 44100

def env(n, a=0.004, d=None, peak=1.0, tail=0.0):
    t = np.arange(n) / SR
    d = d if d is not None else n / SR
    e = np.minimum(t / a, 1.0) * np.exp(-t / (d / 4.5))
    return e * peak

def tone(f, dur, wave_='sine', harm=(1.0,), glide=0.0, a=0.004, decay=None):
    n = int(dur * SR); t = np.arange(n) / SR
    fr = f * (1 + glide * np.exp(-t * 18))
    ph = 2 * np.pi * np.cumsum(fr) / SR
    s = np.zeros(n)
    for k, g in enumerate(harm, 1):
        if wave_ == 'tri':
            s += g * (2 / np.pi) * np.arcsin(np.sin(k * ph))
        else:
            s += g * np.sin(k * ph)
    return s * env(n, a, decay)

def seq(parts, gap=0.0):
    out = []
    for p in parts:
        out.append(p); out.append(np.zeros(int(gap * SR)))
    return np.concatenate(out)

def overlay(parts, offsets):
    n = max(int(o * SR) + len(p) for p, o in zip(parts, offsets))
    out = np.zeros(n)
    for p, o in zip(parts, offsets):
        i = int(o * SR); out[i:i + len(p)] += p
    return out

def reverb(x, amt=0.18, dur=0.18):
    n = int(dur * SR)
    ir = np.random.default_rng(1).standard_normal(n) * np.exp(-np.arange(n) / (n / 4))
    ir[0] = 0
    y = np.convolve(x, ir)[:len(x) + n] * (amt / np.max(np.abs(ir)) / 6)
    out = np.zeros(len(y)); out[:len(x)] += x; out += y
    return out

def norm(x, db=-6):
    x = x / (np.max(np.abs(x)) + 1e-9) * (10 ** (db / 20))
    # fade out
    f = int(0.004 * SR); x[-f:] *= np.linspace(1, 0, f)
    return x

def wav_b64(x):
    pcm = (np.clip(x, -1, 1) * 32767).astype('<i2')
    import io
    b = io.BytesIO(); w = wave.open(b, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes()); w.close()
    return base64.b64encode(b.getvalue()).decode()

A, B = {}, {}
# ---- A = clean/minimal (sine), B = richer (triangle+harmonics, glide, reverb) ----
H = (1.0, 0.35, 0.12)
# connect: rising two-note
A['connect'] = seq([tone(660, .09), tone(990, .16)], .01)
B['connect'] = reverb(seq([tone(659, .10, 'tri', H), tone(988, .22, 'tri', H, decay=.22)], .0))
# disconnect: falling two-note, lower
A['disconnect'] = seq([tone(520, .12), tone(330, .22)], .02)
B['disconnect'] = reverb(seq([tone(494, .13, 'tri', H), tone(294, .30, 'tri', H, decay=.3)], .01), .25, .25)
# order placed: single short tick
A['order_placed'] = tone(880, .06)
B['order_placed'] = tone(1047, .07, 'tri', H, glide=.05)
# fill: confirm ding
A['fill'] = tone(1319, .18)
B['fill'] = reverb(overlay([tone(1319, .22, 'sine', (1, .2)), tone(2637, .10, 'sine', (.3,))], [0, .0]), .15, .15)
# partial fill: two quick ticks
A['partial_fill'] = seq([tone(880, .05), tone(880, .05)], .04)
B['partial_fill'] = seq([tone(1047, .06, 'tri', H), tone(1319, .08, 'tri', H)], .035)
# rejected: low buzz double
A['rejected'] = seq([tone(220, .08), tone(220, .12)], .05)
B['rejected'] = seq([tone(196, .09, 'tri', (1, .6, .3)), tone(165, .16, 'tri', (1, .6, .3))], .05)
# TP hit: bright ascending 3
A['tp'] = seq([tone(880, .07), tone(1109, .07), tone(1319, .18)], .0)
B['tp'] = reverb(seq([tone(784, .08, 'tri', H), tone(988, .08, 'tri', H), tone(1319, .26, 'tri', H, decay=.26)], 0), .18, .2)
# SL hit: descending 2, muted
A['sl'] = seq([tone(660, .09), tone(440, .20)], .01)
B['sl'] = reverb(seq([tone(587, .10, 'tri', H), tone(392, .26, 'tri', H, decay=.26)], .01), .15, .2)
# stop-out: 3 pulses low urgent
A['stop_out'] = seq([tone(330, .12)] * 3, .07)
B['stop_out'] = seq([tone(311, .13, 'tri', (1, .7, .4)), tone(311, .13, 'tri', (1, .7, .4)), tone(262, .22, 'tri', (1, .7, .4))], .06)
# margin call: 2 pulses mid
A['margin_call'] = seq([tone(440, .16)] * 2, .08)
B['margin_call'] = seq([tone(466, .17, 'tri', (1, .6, .3)), tone(466, .22, 'tri', (1, .6, .3))], .08)
# pending triggered: tick + ding
A['pending_triggered'] = seq([tone(660, .05), tone(1319, .14)], .03)
B['pending_triggered'] = reverb(seq([tone(784, .06, 'tri', H), tone(1568, .18, 'tri', H)], .03), .12, .15)
# price alert: bell
A['price_alert'] = tone(1760, .35, decay=.35)
B['price_alert'] = reverb(overlay([tone(1760, .45, 'sine', (1, .15), decay=.45), tone(2640, .2, 'sine', (.25,))], [0, 0]), .22, .3)
# notification: soft single
A['notification'] = tone(1047, .12)
B['notification'] = reverb(tone(1175, .16, 'tri', (1, .25)), .1, .12)
# BO dealer queue: 2 quick pings
A['dealer_queue'] = seq([tone(1319, .06), tone(1319, .06)], .03)
B['dealer_queue'] = seq([tone(1319, .07, 'tri', H), tone(1760, .09, 'tri', H)], .03)
# BO reminder: 1 longer ping
A['reminder'] = tone(988, .25, decay=.25)
B['reminder'] = reverb(tone(988, .3, 'tri', (1, .3), decay=.3), .12, .15)

# ---- round 2: 6 extra events ----
# position closed (manual): soft descending confirm, shorter than fill
A['position_closed'] = seq([tone(1047, .07), tone(784, .14)], .0)
B['position_closed'] = reverb(seq([tone(1047, .08, 'tri', H), tone(784, .18, 'tri', H)], .0), .12, .15)
# pending placed / cancelled: single low tick
A['pending_placed'] = tone(587, .06)
B['pending_placed'] = tone(587, .07, 'tri', H, glide=.04)
# SL/TP modified: double soft tick
A['modified'] = seq([tone(740, .04), tone(880, .05)], .03)
B['modified'] = seq([tone(740, .05, 'tri', H), tone(988, .06, 'tri', H)], .03)
# generic error: neutral single low tone (not the rejected buzz)
A['error'] = tone(294, .22, decay=.22)
B['error'] = reverb(tone(294, .26, 'tri', (1, .5, .2), decay=.26), .1, .15)
# hedge escalation (BO): 3 rising urgent pulses
A['hedge_escalation'] = seq([tone(660, .09), tone(784, .09), tone(988, .14)], .05)
B['hedge_escalation'] = seq([tone(660, .1, 'tri', (1, .6, .3)), tone(784, .1, 'tri', (1, .6, .3)), tone(988, .18, 'tri', (1, .6, .3))], .05)
# feed stale / LP down (BO): slow double low
A['feed_stale'] = seq([tone(392, .18), tone(392, .18)], .14)
B['feed_stale'] = seq([tone(370, .2, 'tri', (1, .5, .25)), tone(370, .24, 'tri', (1, .5, .25))], .14)

# ---- final set: (key, label, app, default on) in shipping order ----
# Reused, no file of their own: requote -> notification (ON), approval-waiting -> notification (default OFF).
# position_closed replaces fill on manual / 1-click closes; error = network / 5xx, distinct from rejected.
FINAL = [
    ("connect", "Connected", "terminal", True),
    ("disconnect", "Disconnected", "terminal", True),
    ("order_placed", "Order placed", "terminal", True),
    ("fill", "Trade filled", "terminal", True),
    ("position_closed", "Position closed", "terminal", True),
    ("partial_fill", "Partial fill", "terminal", True),
    ("rejected", "Order rejected", "terminal", True),
    ("error", "Network or server error", "terminal", True),
    ("tp", "Take profit hit", "terminal", True),
    ("sl", "Stop loss hit", "terminal", True),
    ("stop_out", "Stop-out", "terminal", True),
    ("margin_call", "Margin call", "terminal", True),
    ("pending_placed", "Pending order placed", "terminal", False),
    ("pending_triggered", "Pending order triggered", "terminal", True),
    ("modified", "Order modified", "terminal", False),
    ("price_alert", "Price alert", "terminal", True),
    ("notification", "Notification", "terminal", True),
    ("dealer_queue", "Dealer queue order", "backoffice", True),
    ("reminder", "Dealer queue reminder", "backoffice", True),
    ("hedge_escalation", "Hedge escalation", "backoffice", True),
    ("feed_stale", "Price feed stale", "backoffice", True),
]

HERE = os.path.dirname(os.path.abspath(__file__))
WAV_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "public", "sounds", "v2"))   # the shipped set
MANIFEST = os.path.join(HERE, "manifest.csv")                                           # the checksum manifest


def main(out_dir):
    import csv, glob, hashlib
    os.makedirs(out_dir, exist_ok=True)
    names = [f"{i:02d}-{key.replace('_', '-')}.wav" for i, (key, *_rest) in enumerate(FINAL, 1)]
    for old in glob.glob(os.path.join(out_dir, "*.wav")):    # no stale file from an earlier set survives a regenerate
        if os.path.basename(old) not in names:
            os.remove(old)
    rows = []
    for name, (key, label, app, on) in zip(names, FINAL):
        x = norm(A[key])
        path = os.path.join(out_dir, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(wav_b64(x)))
        with open(path, "rb") as f:
            sha = hashlib.sha256(f.read()).hexdigest()
        rows.append((name, label, round(len(x) * 1000 / SR), os.path.getsize(path), sha, key, app, "on" if on else "off"))
    with open(MANIFEST, "w", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows([("file", "event", "duration_ms", "bytes", "sha256", "key", "app", "default")] + rows)
    for r in rows:
        print(*r, sep="\t")


if __name__ == "__main__":
    import sys
    # python tools/sounds-v2/generate.py            rewrites public/sounds/v2/*.wav and tools/sounds-v2/manifest.csv
    main(sys.argv[1] if len(sys.argv) > 1 else WAV_DIR)
