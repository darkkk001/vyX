import type { ChartSettings } from "@/lib/chart-settings";

// MT5-style terminal notification cues -- short (<400ms) synthesized Web
// Audio tones, same technique as the price-alert chime (single-shot
// AudioContext per sound, sine oscillators with a quick-attack/
// exponential-decay gain envelope): no asset to ship, no autoplay-policy
// prompt (each sound only ever plays in direct response to a real
// trading event the trader is already looking at the terminal for), and
// consistent across every browser/OS instead of depending on a bundled
// audio file's licensing or format support.
export type SoundEvent =
  | "orderFilled"
  | "positionClosed"
  | "slHit"
  | "tpHit"
  | "pendingTriggered"
  | "requoteReceived"
  | "alertTriggered"
  | "error";

type Tone = { freq: number; start: number; duration: number; gain?: number; type?: OscillatorType };

// Each event gets a distinct, deliberately short shape so they're
// tellable apart by ear the way MT5's own fill/error sounds are --
// ascending pairs read as "good" (fill, TP, alert), a descending pair
// reads as "loss" (SL), a single short blip reads as neutral/informational
// (pending triggered), an alternating pair reads as "needs attention"
// (requote), and a low buzz reads as "something went wrong" (error).
const TONE_SHAPES: Record<SoundEvent, Tone[]> = {
  orderFilled: [
    { freq: 880, start: 0, duration: 0.09 },
    { freq: 1318.51, start: 0.07, duration: 0.12 },
  ],
  positionClosed: [
    { freq: 740, start: 0, duration: 0.1 },
    { freq: 988, start: 0.08, duration: 0.12 },
  ],
  slHit: [
    { freq: 587.33, start: 0, duration: 0.11 },
    { freq: 392, start: 0.09, duration: 0.16 },
  ],
  tpHit: [
    { freq: 880, start: 0, duration: 0.09 },
    { freq: 1174.66, start: 0.07, duration: 0.09 },
    { freq: 1567.98, start: 0.14, duration: 0.14 },
  ],
  pendingTriggered: [{ freq: 988, start: 0, duration: 0.1 }],
  requoteReceived: [
    { freq: 987.77, start: 0, duration: 0.07 },
    { freq: 659.25, start: 0.09, duration: 0.07 },
    { freq: 987.77, start: 0.18, duration: 0.1 },
  ],
  // Kept identical to the original alert chime (two rising sine notes) so
  // an existing trader's muscle memory for "that sound means an alert
  // fired" carries over unchanged once alerts are wired into this module.
  alertTriggered: [
    { freq: 880, start: 0, duration: 0.18 },
    { freq: 1174.66, start: 0.12, duration: 0.18 },
  ],
  error: [{ freq: 220, start: 0, duration: 0.2, type: "square", gain: 0.08 }],
};

// A fresh AudioContext per call (the original approach here, and the one
// lib/sounds.ts's predecessor playAlertChime also used) can come back
// `state: "suspended"` instead of "running" for a call that isn't
// synchronously inside a click's own call stack -- which is exactly what
// most of these events are (a WS push, a polling-diff detecting a fill/
// close/SL/TP that happened asynchronously). start()/stop() on a
// suspended context's oscillator throws nothing and logs nothing -- it
// just produces no audible output, which is indistinguishable from "the
// feature doesn't work" to a trader with sound genuinely toggled on.
// A single shared, lazily-created context that's explicitly .resume()d
// before every use fixes this: once resumed after any real gesture on
// the page, it stays running for the rest of the session, the same
// "sticky activation" every other autoplay-gated API relies on -- and
// this app never needs more than one context at a time anyway.
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  sharedCtx = new AudioContextCtor();
  return sharedCtx;
}

function playTones(tones: Tone[]) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const schedule = () => {
      const now = ctx.currentTime;
      for (const tone of tones) {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.type = tone.type ?? "sine";
        osc.frequency.value = tone.freq;
        const start = now + tone.start;
        const end = start + tone.duration;
        const peak = tone.gain ?? 0.2;
        gainNode.gain.setValueAtTime(0, start);
        gainNode.gain.linearRampToValueAtTime(peak, start + 0.015);
        gainNode.gain.exponentialRampToValueAtTime(0.001, end);
        osc.connect(gainNode).connect(ctx.destination);
        osc.start(start);
        osc.stop(end + 0.02);
      }
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(schedule).catch(() => {});
    } else {
      schedule();
    }
  } catch {
    // Autoplay policy / no audio device / unsupported -- the toast/UI
    // change that triggered this already conveys the event, so a silent
    // failure here is fine.
  }
}

const SETTINGS_KEY: Record<SoundEvent, keyof ChartSettings> = {
  orderFilled: "soundOrderFilled",
  positionClosed: "soundPositionClosed",
  slHit: "soundSlHit",
  tpHit: "soundTpHit",
  pendingTriggered: "soundPendingTriggered",
  requoteReceived: "soundRequoteReceived",
  alertTriggered: "soundAlertTriggered",
  error: "soundError",
};

// The one call site every event handler needs -- checks the master
// switch and the per-event toggle from the trader's own persisted chart
// settings before synthesizing anything.
export function playSound(event: SoundEvent, settings: Pick<ChartSettings, "soundsEnabled"> & Partial<ChartSettings>) {
  if (typeof window === "undefined") return;
  if (!settings.soundsEnabled) return;
  if (settings[SETTINGS_KEY[event]] === false) return;
  playTones(TONE_SHAPES[event]);
}
