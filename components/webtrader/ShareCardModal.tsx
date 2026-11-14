"use client";
// Owner 2026-11-14: the interactive PNL share card for the WebTrader, the same card as the native terminal (Vyx.Trader.App ShareCard):
// a 1200x630 canvas (what you see is exactly what Download saves). A tap in the middle switches the hero between points and money; a swipe
// left / right cycles the background artwork (the profit set on a win, the loss set on a loss). The last hero and artwork are remembered.
// Content share settings (User nickname, PNL amount) and the share actions (Download, Copy link, Telegram, X, More) sit under the card.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLASSIC,
  artFor,
  artSet,
  gesture,
  heroLines,
  loadPrefs,
  nextArt,
  pointsText,
  savePrefs,
  shownHero,
  summaryText,
  type ShareHero,
  type ShareTrade,
} from "@/lib/share-card";

export type ShareCardInfo = ShareTrade & {
  /** "Current" for an open position, "Close" for a closed trade. */
  exitLabel: string;
  leverage: number;
  brand: string;
  logoUrl: string;
  accountNumber: string;
  mode: "LIVE" | "DEMO" | "";
  trader: string;
  at: Date;
};

export type ShareReferral = { code: string; link: string; qr: string } | null;

const W = 1200, H = 630;
const OK = "#3DCC7E", DOWN = "#C84A4A", UP = "#4A7DD6";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "Inter, system-ui, sans-serif";

function mix(hex: string, toward: string, t: number): string {
  const a = parseInt(hex.slice(1), 16), b = parseInt(toward.slice(1), 16);
  const ch = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
    imgCache.set(src, p);
  }
  return p;
}

function maskAccount(n: string): string {
  return n.length > 4 ? "•".repeat(n.length - 4) + n.slice(-4) : n;
}

async function draw(cv: HTMLCanvasElement, t: ShareCardInfo, o: { hero: ShareHero; art: string; showName: boolean; showAmount: boolean; referral: ShareReferral; accent: string }) {
  const c = cv.getContext("2d");
  if (!c) return;
  const [artImg, logoImg, qrImg] = await Promise.all([
    (() => { const a = artSet(t).find((x) => x.key === artFor(t, o.art)); return a?.src ? loadImage(a.src) : Promise.resolve(null); })(),
    t.logoUrl ? loadImage(t.logoUrl) : Promise.resolve(null),
    o.referral?.qr ? loadImage(o.referral.qr) : Promise.resolve(null),
  ]);
  const pc = t.pnl >= 0 ? OK : DOWN;
  const field = mix(pc, "#000000", 0.52), panel = mix(pc, "#000000", 0.74);
  c.clearRect(0, 0, W, H);
  c.fillStyle = field; c.fillRect(0, 0, W, H);
  if (artImg) {
    // the artwork replaces the diagonal panel on the right, fading into the field (only the background changes)
    const x0 = W - H - 20, size = H + 20;
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const oc = off.getContext("2d")!;
    oc.drawImage(artImg, x0, -10, size + 10, size);
    oc.globalCompositeOperation = "destination-in";
    const g = oc.createLinearGradient(x0, 0, x0 + size * 0.45, 0); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,1)");
    oc.fillStyle = g; oc.fillRect(0, 0, W, H);
    c.drawImage(off, 0, 0);
    const v = c.createLinearGradient(0, 0, W, 0); v.addColorStop(0.6, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.27)");
    c.fillStyle = v; c.fillRect(0, 0, W, H);
    const f = c.createLinearGradient(0, H - 190, 0, H); f.addColorStop(0, "rgba(0,0,0,0)"); f.addColorStop(1, field);
    c.save(); c.globalAlpha = 0.92; c.fillStyle = f; c.fillRect(0, H - 190, W, 190); c.restore();
    if (o.referral && qrImg) { c.save(); c.filter = "blur(18px)"; c.fillStyle = "rgba(0,0,0,0.59)"; c.beginPath(); c.roundRect(W - 72 - 112 - 230, 330, 72 + 112 + 230 - 20, 170, 18); c.fill(); c.restore(); }
  } else {
    c.fillStyle = panel; c.beginPath(); c.moveTo(W * 0.62, 0); c.lineTo(W, 0); c.lineTo(W, H); c.lineTo(W * 0.5, H); c.closePath(); c.fill();
    c.strokeStyle = o.accent; c.lineWidth = 7; c.beginPath(); c.moveTo(W * 0.62, -4); c.lineTo(W * 0.5, H + 4); c.stroke();
  }
  c.fillStyle = o.accent; c.fillRect(0, 0, 8, H);
  c.textBaseline = "middle";

  // brand: logo, else the name in the accent; the LIVE / DEMO tag after it
  let brandEnd = 64; const brandMid = 70;
  if (logoImg && logoImg.height > 0) {
    let bh = 40, lw = (logoImg.width * bh) / logoImg.height; if (lw > 380) { bh = (380 * logoImg.height) / logoImg.width; lw = 380; }
    c.drawImage(logoImg, 64, brandMid - bh / 2, lw, bh); brandEnd = 64 + lw;
  } else {
    c.font = `700 28px ${MONO}`; c.fillStyle = o.accent; const name = t.brand.toUpperCase(); c.fillText(name, 64, brandMid); brandEnd = 64 + c.measureText(name).width;
  }
  if (t.mode) {
    const label = t.mode === "LIVE" ? "LIVE ACCOUNT" : "DEMO ACCOUNT";
    c.font = `600 12px ${SANS}`; const tw = c.measureText(label).width; const x0 = brandEnd + 16, x1 = x0 + tw + 28, y0 = brandMid - 11;
    c.fillStyle = "rgba(10,20,15,0.85)"; c.beginPath(); c.roundRect(x0, y0, x1 - x0, 22, 4); c.fill();
    c.strokeStyle = "rgba(61,204,126,0.67)"; c.lineWidth = 1; c.stroke();
    c.fillStyle = OK; c.beginPath(); c.arc(x0 + 10, brandMid, 3, 0, Math.PI * 2); c.fill(); c.fillText(label, x0 + 19, brandMid);
  }
  let y = 118;
  if (o.showName && t.trader.trim()) {
    const who = t.trader.trim();
    c.fillStyle = o.accent; c.beginPath(); c.arc(78, y + 4, 14, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#fff"; c.font = `700 15px ${MONO}`; c.textAlign = "center"; c.fillText(who[0].toUpperCase(), 78, y + 4); c.textAlign = "left";
    c.fillStyle = "#F4F6F8"; c.font = `600 22px ${SANS}`; let shown = who; while (shown.length > 4 && c.measureText(shown).width > 520) shown = shown.slice(0, -2);
    c.fillText(shown === who ? who : shown.trimEnd() + "…", 104, y + 4); y += 44;
  } else y += 8;
  // side chip + symbol + leverage
  c.font = `600 17px ${MONO}`; const side = `${t.isBuy ? "BUY" : "SELL"} ${t.lots.toFixed(2)}`; const pw = c.measureText(side).width + 24;
  c.fillStyle = t.isBuy ? UP : DOWN; c.beginPath(); c.roundRect(64, y, pw, 30, 4); c.fill();
  c.fillStyle = "#fff"; c.fillText(side, 76, y + 15);
  c.font = `600 26px ${MONO}`; c.fillStyle = "#F4F6F8"; c.fillText(t.symbol, 64 + pw + 14, y + 15); const sw = c.measureText(t.symbol).width;
  c.font = `500 18px ${MONO}`; c.fillStyle = "rgba(255,255,255,0.75)"; c.fillText(`1:${t.leverage}`, 64 + pw + 14 + sw + 14, y + 15);
  y += 30;
  // hero + secondary
  const { hero, secondary } = heroLines(t, o.hero, o.showAmount);
  c.textBaseline = "alphabetic"; let size = 104; c.font = `700 ${size}px ${MONO}`;
  const maxW = o.referral ? 600 : W - 128; while (size > 48 && c.measureText(hero).width > maxW) { size -= 2; c.font = `700 ${size}px ${MONO}`; }
  const base = y + 20 + size * 0.82; c.fillStyle = "#fff"; c.fillText(hero, 58, base); y = base;
  c.font = `600 34px ${MONO}`; c.fillStyle = "rgba(255,255,255,0.88)"; y += 50; c.fillText(secondary, 64, y);
  // ENTRY | exit | MOVE
  { const x0 = 64, x1 = 640, y0 = Math.max(y + 28, 380), y1 = y0 + 76, cw = (x1 - x0) / 3;
    c.fillStyle = "rgba(0,0,0,0.35)"; c.beginPath(); c.roundRect(x0, y0, x1 - x0, y1 - y0, 12); c.fill(); c.strokeStyle = "rgba(255,255,255,0.16)"; c.lineWidth = 1; c.stroke();
    const cols: [string, string][] = [["ENTRY", t.entry.toFixed(t.digits)], [t.exitLabel.toUpperCase(), t.exit.toFixed(t.digits)], ["MOVE", pointsText(t).replace(/^\+/, "")]];
    c.textAlign = "center"; c.textBaseline = "middle";
    cols.forEach(([l, v], i) => {
      const cx = x0 + cw * i + cw / 2;
      c.font = `600 13px ${SANS}`; c.fillStyle = "rgba(255,255,255,0.6)"; c.fillText(l, cx, y0 + 23);
      c.font = `500 21px ${MONO}`; c.fillStyle = "#F4F6F8"; c.fillText(v, cx, y0 + 51);
      if (i > 0) { c.strokeStyle = "rgba(255,255,255,0.18)"; c.beginPath(); c.moveTo(x0 + cw * i, y0 + 15); c.lineTo(x0 + cw * i, y1 - 15); c.stroke(); }
    });
    c.textAlign = "left"; }
  // the referral code + QR
  if (o.referral && qrImg) {
    const s = 112, qx = W - 72 - s, qy = 360;
    c.fillStyle = "#fff"; c.beginPath(); c.roundRect(qx - 8, qy - 8, s + 16, s + 16, 10); c.fill(); c.imageSmoothingEnabled = false; c.drawImage(qrImg, qx, qy, s, s); c.imageSmoothingEnabled = true;
    c.textAlign = "right"; c.textBaseline = "alphabetic";
    c.font = `600 14px ${SANS}`; c.fillStyle = "rgba(255,255,255,0.75)"; c.fillText("REFERRAL CODE", qx - 24, qy + 34);
    c.font = `700 24px ${MONO}`; c.fillStyle = "#F4F6F8"; c.fillText(o.referral.code, qx - 24, qy + 68);
    c.font = `600 14px ${SANS}`; c.fillStyle = o.accent; c.fillText("Scan to join", qx - 24, qy + 96); c.textAlign = "left";
  }
  // footer
  c.strokeStyle = "rgba(255,255,255,0.18)"; c.beginPath(); c.moveTo(64, 530.5); c.lineTo(W - 64, 530.5); c.stroke();
  c.textBaseline = "middle"; c.font = `400 17px ${MONO}`; c.fillStyle = "rgba(255,255,255,0.75)";
  const when = t.at.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).toUpperCase() + " UTC";
  c.fillText((t.accountNumber ? `Account ${maskAccount(t.accountNumber)}  ·  ` : "") + when, 64, 572);
  c.font = `600 20px ${SANS}`; c.fillStyle = o.accent; c.textAlign = "right"; c.fillText(`Trade with ${t.brand}  →`, W - 64, 572); c.textAlign = "left";
}

export default function ShareCardModal({ trade, accent, referral, onClose }: { trade: ShareCardInfo; accent: string; referral: ShareReferral; onClose: () => void }) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [hero, setHero] = useState<ShareHero>(() => loadPrefs(trade).hero);
  const [art, setArt] = useState<string>(() => loadPrefs(trade).art);
  const [showName, setShowName] = useState(true);
  const [showAmount, setShowAmount] = useState(true);
  const [toast, setToast] = useState("");
  const press = useRef<{ x: number; y: number } | null>(null);
  const win = trade.pnl >= 0;
  const artName = useMemo(() => artSet(trade).find((a) => a.key === artFor(trade, art))?.name ?? "Classic", [trade, art]);

  useEffect(() => { if (cv.current) void draw(cv.current, trade, { hero, art, showName, showAmount, referral, accent }); }, [trade, hero, art, showName, showAmount, referral, accent]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(""), 2500); return () => clearTimeout(id); }, [toast]);
  // a result that turns (an open position crossing zero) uses the other set: its own remembered artwork
  useEffect(() => { setArt(loadPrefs(trade).art); }, [win]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleHero = useCallback(() => {
    const next: ShareHero = hero === "points" ? "money" : "points";
    setHero(next); savePrefs(trade, next, art);
    if (shownHero(next, showAmount) !== next) setToast("Turn on PNL amount to lead with the amount");
  }, [hero, art, trade, showAmount]);
  const swipe = useCallback((steps: number) => { const a = nextArt(trade, art, steps); setArt(a); savePrefs(trade, hero, a); }, [trade, art, hero]);

  function onDown(e: React.PointerEvent<HTMLDivElement>) { const r = e.currentTarget.getBoundingClientRect(); press.current = { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function onUp(e: React.PointerEvent<HTMLDivElement>) {
    const p0 = press.current; press.current = null; if (!p0) return;
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    const g = gesture(x - p0.x, y - p0.y, x, y, r.width, r.height);
    if (g === "toggle") toggleHero(); else if (g === "next") swipe(1); else if (g === "prev") swipe(-1);
  }

  const fileName = () => `${trade.symbol}-${trade.isBuy ? "BUY" : "SELL"}-${trade.at.toISOString().slice(0, 19).replace(/[:T]/g, "")}.png`;
  const blob = () => new Promise<Blob | null>((res) => cv.current ? cv.current.toBlob((b) => res(b), "image/png") : res(null));
  async function download() { const b = await blob(); if (!b) { setToast("Could not save the card"); return; } const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = fileName(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); setToast(`Saved as ${fileName()}`); }
  const text = () => summaryText(trade, trade.brand, trade.leverage) + (referral?.link ? ` ${referral.link}` : "");
  async function copy(s: string, ok: string) { try { await navigator.clipboard.writeText(s); setToast(ok); } catch { setToast("Could not copy"); } }
  async function act(a: string) {
    if (a === "download") return download();
    if (a === "copylink") return referral?.link ? copy(referral.link, "Link copied") : setToast("No referral link: links come with a partner (IB) account");
    if (a === "telegram" || a === "x") {
      await download();
      const url = a === "telegram" ? `https://t.me/share/url?url=${encodeURIComponent(referral?.link ?? "")}&text=${encodeURIComponent(text())}` : `https://x.com/intent/post?text=${encodeURIComponent(text())}`;
      window.open(url, "_blank", "noopener"); setToast("Card saved: attach it to your post"); return;
    }
    if (a === "more") {
      const b = await blob();
      const file = b ? new File([b], fileName(), { type: "image/png" }) : null;
      if (file && typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text: text() }); return; } catch { /* closed */ } }
      return copy(text(), "Copied");
    }
  }

  return (
    <div className="modal-overlay show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="share-wrap">
        <div className="share-canvas-host" onPointerDown={onDown} onPointerUp={onUp} title="Tap: points / amount · Swipe: background" role="button" aria-label={`Share card. Tap to switch points and amount; swipe for another background (${artName})`}>
          <canvas ref={cv} width={W} height={H} className="share-canvas" />
          <button className="share-close" aria-label="Close" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>✕</button>
          <div className="share-dots" aria-hidden>{artSet(trade).map((a) => <span key={a.key} className={a.key === artFor(trade, art) ? "on" : ""} />)}</div>
          {toast ? <div className="share-toast">{toast}</div> : null}
        </div>
        <div className="share-settings">
          <div className="share-settings-row">
            <span className="share-settings-title">Content share settings</span>
            <label className="share-opt"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> User nickname</label>
            <label className="share-opt"><input type="checkbox" checked={showAmount} onChange={(e) => setShowAmount(e.target.checked)} /> PNL amount</label>
          </div>
          <div className="share-actions">
            {[["download", "Download", "M8,1 L8,10.5 M3.8,6.6 L8,10.8 L12.2,6.6 M1.5,12.5 L1.5,15 L14.5,15 L14.5,12.5"], ["copylink", "Copy link", "M6.5,9.5 L9.5,6.5 M7,4 L8.5,2.5 Q11,0 13.5,2.5 Q16,5 13.5,7.5 L12,9 M9,12 L7.5,13.5 Q5,16 2.5,13.5 Q0,11 2.5,8.5 L4,7"], ["telegram", "Telegram", "M1,7.5 L15,1.5 L12.5,14.5 L7.5,10.5 L12,5 L5.5,9.5 Z M7.5,10.5 L6.5,14 L5.5,9.5"], ["x", "X", "M2,2 L14,14 M14,2 L2,14"], ["more", "More", ""]].map(([k, label, d]) => (
              <button key={k} className="share-act" onClick={() => void act(k)}>
                <span className="disc">{d ? <svg viewBox="0 0 16 16" width="16" height="16"><path d={d} /></svg> : <b>•••</b>}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { CLASSIC };
