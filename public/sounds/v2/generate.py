"""Sounds v2 audition pack: 44.1 kHz mono 16-bit, triangle wave, 8 ms attack, exponential decay, peak -6 dBFS."""
import math, struct, sys, wave, os, csv

SR = 44100
PEAK = 10 ** (-6 / 20)          # -6 dBFS
ATTACK = 0.008
END_DB = -40.0                   # each note decays to -40 dB by its end
TAIL = 0.003                     # last 3 ms linear fade so no note ends on a click


def tri(phase):                  # phase in cycles -> triangle in [-1, 1]
    p = phase % 1.0
    return 4 * p - 1 if p < 0.5 else 3 - 4 * p


def note(f0, ms, f1=None, end_db=END_DB):
    """One note; f1 makes it an exponential glide f0 -> f1 (phase-continuous)."""
    n = int(SR * ms / 1000)
    dur = n / SR
    k = math.log(10 ** (end_db / 20)) / max(dur - ATTACK, 1e-6)   # decay rate after the attack
    out, phase = [], 0.0
    for i in range(n):
        t = i / SR
        f = f0 if f1 is None else f0 * (f1 / f0) ** (t / dur)
        phase += f / SR
        env = t / ATTACK if t < ATTACK else math.exp(k * (t - ATTACK))
        if dur - t < TAIL:
            env *= (dur - t) / TAIL
        out.append(tri(phase) * env)
    return out


def gap(ms):
    return [0.0] * int(SR * ms / 1000)


def seq(*parts):
    s = []
    for p in parts:
        s += p
    return s


E4, A4, E5, A5 = 329.63, 440.0, 659.26, 880.0
SOUNDS = [
    ("fill",          "Trade filled",              note(880, 90)),
    ("partial-fill",  "Partial fill",              seq(note(880, 60), gap(50), note(880, 60))),
    ("close",         "Position closed",           note(660, 90)),
    ("tp",            "Take profit hit",           seq(note(E5, 90), note(A5, 90))),
    ("sl",            "Stop loss hit",             seq(note(A4, 110), note(E4, 110))),
    ("stop-out",      "Stop-out",                  seq(note(440, 120), gap(70), note(440, 120), gap(70), note(440, 120))),
    ("margin-call",   "Margin call",               seq(note(330, 160), gap(80), note(330, 160))),
    ("reject",        "Order rejected",            note(220, 150)),
    ("requote",       "Requote",                   seq(note(700, 100), note(900, 100))),
    ("cancel",        "Order cancelled",           note(800, 150, f1=500)),
    ("price-alert",   "Price alert",               note(1200, 350, end_db=-30)),
    ("notification",  "Notification",              note(1000, 80)),
    ("connect",       "Connected",                 note(400, 250, f1=800)),
    ("disconnect",    "Disconnected",              note(800, 300, f1=400)),
    ("dealer-queue",  "Dealer queue order",        seq(note(1000, 90), gap(20), note(1200, 90))),
    ("reminder",      "Dealer queue reminder",     note(1000, 100)),
]


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    rows = []
    for i, (key, label, s) in enumerate(SOUNDS, 1):
        peak = max(abs(x) for x in s)
        pcm = b"".join(struct.pack("<h", int(round(x / peak * PEAK * 32767))) for x in s)
        name = f"{i:02d}-{key}.wav"
        with wave.open(os.path.join(out_dir, name), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
        rows.append((name, label, round(len(s) * 1000 / SR), os.path.getsize(os.path.join(out_dir, name))))
    with open(os.path.join(out_dir, "manifest.csv"), "w", newline="") as f:
        csv.writer(f).writerows([("file", "event", "duration_ms", "bytes")] + rows)
    for r in rows:
        print(*r, sep="\t")


if __name__ == "__main__":
    main(sys.argv[1])
