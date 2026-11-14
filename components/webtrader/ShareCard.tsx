"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { avatarBg, avatarPath } from "@/lib/avatars";
import { heroLines, linePoints, maskedAccount, movePercent, movePips, shareFileName, shareLink, shareSlides, shareStart, shareText, smoothPath, telegramShareUrl, xShareUrl, type ShareMe, type ShareSide, type Slide } from "@/lib/share-card";

export type { ShareMe } from "@/lib/share-card";

// WebTrader share card (owner 2026-11-14). Layout, colours, fonts, sizes and animation are the prototype's
// (C:\vyx\handoff\share-card-prototype.html; the Bitmoji card is share-card-popout-reference.html design A); the CSS is
// webtrader.css "Share card". Profit: the avatar in its colours, green, the line going up. Loss: the avatar dimmed with
// a red shade and rain lines, red, the line going down. Swipe (or the arrows) changes the avatar within the list of the
// card's own mood; a tap switches the hero between money and pips. The buttons under it (owner 2026-11-14): Download
// (the card as a PNG), Copy link (the referral register link), Telegram / X / More (a phone: the phone's share menu with
// the image; a desktop: the share page with the text and the link, the image downloaded beside it).

export type ShareTrade = { symbol: string; side: ShareSide; lots: string; entry: number; current: number; digits: number; pnl: number; openedAt: string };

const GREEN = "#3DDC97", RED = "#FF5A5A", LOSS_BG = "#0D0707";
const POP_BG = "linear-gradient(120deg,#1E5A3C 0%,#16442E 55%,#0F3322 100%)";
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(",");
const slideName = (s: Slide) => (s.kind === "bitmoji" ? "Bitmoji" : s.name.replace(/_/g, " "));

export default function ShareCard(p: {
  trade: ShareTrade; series: number[] | null; currency: string; me: ShareMe | null; fallbackLists: { profit: string[]; loss: string[] };
  brokerName: string; brokerLogoUrl: string; domain: string; origin: string; accountNumber: string; accountMode: "LIVE" | "DEMO"; nickname: string;
  onToast: (message: string, ok?: boolean) => void;
}) {
  const { trade } = p;
  const loss = trade.pnl < 0;
  const slides = useMemo(() => shareSlides(p.me, loss, p.fallbackLists), [p.me, loss, p.fallbackLists]);
  const [i, setI] = useState(() => shareStart(slides, p.me, loss));
  const [shown, setShown] = useState(i);
  const [out, setOut] = useState<0 | 1 | -1>(0);
  useEffect(() => { const s = shareStart(slides, p.me, loss); setI(s); setShown(s); setOut(0); }, [slides, p.me, loss]);
  const [view, setView] = useState<"money" | "pips">("money");
  const [opt, setOpt] = useState({ nick: true, pnl: true, price: true, graph: true });
  const n = slides.length;

  // the prototype's swap: the old picture slides 30 px out and fades, the new one comes in after 180 ms
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (i === shown) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setShown(i); setOut(0); }, 180);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [i, shown]);
  const step = useCallback((d: 1 | -1) => { if (n < 2) return; setOut(d); setI((x) => (x + d + n) % n); }, [n]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "ArrowRight") step(1); if (e.key === "ArrowLeft") step(-1); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [step]);
  // keep the pictures next to this one loaded, so a swipe never waits
  useEffect(() => {
    for (const d of [1, -1]) { const s = slides[(i + d + n) % n]; if (s?.kind === "preset") { const im = new Image(); im.src = avatarPath(s.name, 1024); } }
  }, [i, n, slides]);

  const slide = slides[shown] ?? slides[0];
  const pop = slide?.kind === "bitmoji";
  const col = loss ? RED : GREEN;
  const bg = loss ? LOSS_BG : slide?.kind === "preset" ? avatarBg(slide.name) : "#16442E";
  const r = rgb(bg);
  const pips = movePips(trade.entry, trade.current, trade.digits, trade.side);
  const pct = movePercent(trade.entry, trade.current, trade.side);
  const hero = heroLines({ pnl: trade.pnl, currency: p.currency, pips, pct, showPnl: opt.pnl, view });
  const nameTag = p.me?.nameTag || p.nickname;
  const fmt = (v: number) => v.toFixed(trade.digits);
  const sell = trade.side === "SELL";

  // the line: the trade's own prices (null while they load = the entry and the current price)
  const P = useMemo(() => linePoints(p.series && p.series.length >= 2 ? p.series : sell ? [-trade.entry, -trade.current] : [trade.entry, trade.current]), [p.series, sell, trade.entry, trade.current]);
  const d = smoothPath(P);
  const E = P[P.length - 1];
  const g = loss ? "gl" : "gp";
  const svgRef = useRef<SVGSVGElement | null>(null);
  const lnRef = useRef<SVGPathElement | null>(null);
  const dotRef = useRef<HTMLElement | null>(null);
  const placeArrow = useCallback(() => {
    const sv = svgRef.current, ln = lnRef.current, dot = dotRef.current;
    if (!sv || !ln || !dot) return;
    const L = ln.getTotalLength(), a = ln.getPointAtLength(L), b = ln.getPointAtLength(Math.max(0, L - 6)), M = sv.getScreenCTM();
    const box = sv.parentElement?.getBoundingClientRect();
    if (!M || !box) return;
    const A = new DOMPoint(a.x, a.y).matrixTransform(M), B = new DOMPoint(b.x, b.y).matrixTransform(M);
    dot.style.left = `${A.x - box.left}px`; dot.style.top = `${A.y - box.top}px`; dot.style.transform = `rotate(${Math.atan2(A.y - B.y, A.x - B.x)}rad)`;
  }, []);
  useLayoutEffect(() => { const id = requestAnimationFrame(placeArrow); return () => cancelAnimationFrame(id); }, [placeArrow, d, opt.graph, opt.price, opt.pnl, pop]);
  useEffect(() => { window.addEventListener("resize", placeArrow); return () => window.removeEventListener("resize", placeArrow); }, [placeArrow]);

  // tap = money <-> pips (only while the PnL amount shows); a swipe over 40 px = the next / previous avatar
  const sx = useRef<number | null>(null);
  const moved = useRef(false);
  const toggle = () => { if (opt.pnl) setView((v) => (v === "money" ? "pips" : "money")); };
  const when = new Date();
  const stamp = `${when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} \u00b7 ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })} ${new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(when).find((x) => x.type === "timeZoneName")?.value ?? ""}`.trim();
  const bigSize = `${(9.3 * Math.min(1, 9 / Math.max(1, hero.big.length))).toFixed(2)}cqw`;

  // ---- the buttons: the card as a PNG (html-to-image), made in the background once the card settles, so a phone's
  // share menu opens straight from the tap (the browser allows it only right after the tap) ----
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const shot = useRef<{ key: string; blob: Blob } | null>(null);
  const shotKey = JSON.stringify([shown, view, opt, hero.big, hero.sub, d, nameTag, p.me?.referralCode ?? null, loss]);
  const makeImage = useCallback(async (): Promise<Blob | null> => {
    if (shot.current?.key === shotKey) return shot.current.blob;
    const el = stageRef.current, root = rootRef.current;
    if (!el || !root) return null;
    const { toBlob } = await import("html-to-image");
    root.classList.add("wsc-capturing");
    try {
      const blob = await toBlob(el, { pixelRatio: 2 });
      if (blob) shot.current = { key: shotKey, blob };
      return blob;
    } catch {
      return null;
    } finally {
      root.classList.remove("wsc-capturing");
    }
  }, [shotKey]);
  useEffect(() => { const t = setTimeout(() => { void makeImage(); }, 1400); return () => clearTimeout(t); }, [makeImage]);
  const link = shareLink(p.me, p.origin);
  const text = shareText(p.brokerName);
  const fileName = shareFileName(p.brokerName, trade.symbol);
  const [copied, setCopied] = useState(false);
  const saveImage = (b: Blob) => {
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10_000);
  };
  const touchFirst = () => window.matchMedia("(pointer: coarse)").matches;
  const phoneMenu = async (): Promise<boolean> => {
    // a phone (touch first) whose browser can share files: its share menu with the card image, the text and the link
    if (!touchFirst() || typeof navigator.canShare !== "function") return false;
    const b = await makeImage();
    if (!b) return false;
    const f = new File([b], fileName, { type: "image/png" });
    if (!navigator.canShare({ files: [f] })) return false;
    try { await navigator.share({ files: [f], text: `${text}\n${link}` }); } catch (e) { if ((e as Error)?.name !== "AbortError") p.onToast("Could not open the share menu."); }
    return true;
  };
  async function download() {
    const b = await makeImage();
    if (!b) { p.onToast("Could not make the image. Try again."); return; }
    saveImage(b);
    p.onToast("Card image saved", true);
  }
  async function copyLink(quiet = false) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (!quiet) p.onToast("Link copied", true);
      return true;
    } catch {
      p.onToast("Could not copy the link.");
      return false;
    }
  }
  async function shareTo(target: "telegram" | "x") {
    if (touchFirst() && (await phoneMenu())) return;
    // a desktop: the share page opens at once (from the click itself), the image downloads beside it
    const w = window.open(target === "telegram" ? telegramShareUrl(text, link) : xShareUrl(text, link), "_blank");
    if (w) w.opener = null;
    const b = await makeImage();
    if (b) saveImage(b);
  }
  async function more() {
    if (await phoneMenu()) return;
    // a desktop: the system share menu where the browser has one, else the image saved and the link copied
    const b = await makeImage();
    if (b && typeof navigator.canShare === "function") {
      const f = new File([b], fileName, { type: "image/png" });
      if (navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f], text: `${text}\n${link}` }); return; } catch (e) { if ((e as Error)?.name === "AbortError") return; }
      }
    }
    if (b) saveImage(b);
    if (await copyLink(true)) p.onToast(b ? "Image saved and link copied" : "Link copied", true);
  }

  return (
    <div className="wsc" ref={rootRef}>
      <div ref={stageRef} className={`wsc-stage${slides.some((s) => s.kind === "bitmoji") ? " wsc-has-pop" : ""}`}>
        <div
          className={`wsc-card${pop ? " wsc-pop" : ""}`} role="button" tabIndex={0} aria-label="Share card, tap to switch money and pips"
          style={{ background: pop && !loss ? POP_BG : bg }}
          onPointerDown={(e) => { sx.current = e.clientX; moved.current = false; }}
          onPointerMove={(e) => { if (sx.current !== null && Math.abs(e.clientX - sx.current) > 12) moved.current = true; }}
          onPointerUp={(e) => { if (sx.current === null) return; const dx = e.clientX - sx.current; sx.current = null; if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1); else if (!moved.current) toggle(); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
        >
          <div className="wsc-clip">
            {slide?.kind === "preset" ? (
              <div className={`wsc-art${out ? " out" : ""}`} style={{ backgroundImage: `url(${avatarPath(slide.name, 1024)})`, filter: loss ? "grayscale(.75) brightness(.6) contrast(1.1)" : "saturate(1.1)", ["--dx" as string]: `${out > 0 ? -30 : 30}px` }} />
            ) : null}
            {!pop ? <div className="wsc-fade" style={{ background: `linear-gradient(90deg,${bg} 0%,rgba(${r},.92) 38%,rgba(${r},.1) 72%,rgba(${r},0) 100%)` }} /> : null}
            <div className="wsc-fx">
              {loss ? (
                <>
                  <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: "70%", background: "linear-gradient(90deg,transparent,rgba(170,20,25,.45))", mixBlendMode: "multiply" }} />
                  <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(105deg,rgba(255,255,255,.045) 0 1px,transparent 1px 9px)" }} />
                  <div style={{ position: "absolute", inset: 0, background: "radial-gradient(110% 90% at 85% 40%,rgba(229,56,59,.22),transparent 60%)" }} />
                </>
              ) : <div style={{ position: "absolute", inset: 0, background: "radial-gradient(110% 90% at 85% 40%,rgba(61,220,151,.10),transparent 60%)" }} />}
            </div>
          </div>
          <div className="wsc-spark" hidden={!opt.graph}>
            <svg ref={svgRef} viewBox="0 0 351 220" preserveAspectRatio="none" style={{ width: "100%", height: "100%", overflow: "visible" }}>
              <defs>
                <linearGradient id={`${g}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={col} stopOpacity=".32" /><stop offset=".75" stopColor={col} stopOpacity="0" /></linearGradient>
                <filter id={`${g}f`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
              </defs>
              <path d={`${d} L${E[0]},260 L${P[0][0]},260Z`} fill={`url(#${g}a)`} />
              <path d={d} fill="none" stroke={col} strokeWidth="7" opacity=".45" filter={`url(#${g}f)`} />
              <path key={`${d}${shown}`} ref={lnRef} className="wsc-ln" d={d} fill="none" stroke={col} strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>
            <i className="wsc-dot" ref={dotRef} style={{ ["--c" as string]: col, color: col }}>
              <svg viewBox="-10 -10 20 20"><path d="M-6,-6 L4,0 L-6,6" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </i>
          </div>
          {pop && slide.kind === "bitmoji" ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- the client's Bitmoji (Snap's host) */}
              <img className={`wsc-popimg${out ? " out" : ""}`} src={slide.url} alt="" referrerPolicy="no-referrer" style={loss ? { filter: "grayscale(.75) brightness(.6) contrast(1.1)" } : undefined} />
              {opt.nick && nameTag ? <div className="wsc-poptag">@{nameTag}</div> : null}
            </>
          ) : opt.nick && nameTag ? <div className="wsc-nametag">{nameTag}</div> : null}
          <div className="wsc-txt">
            <div className="wsc-brand">
              {/* eslint-disable-next-line @next/next/no-img-element -- the broker's own logo */}
              {p.brokerLogoUrl ? <img src={p.brokerLogoUrl} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <i />}
              {p.brokerName.toUpperCase()} {p.accountMode === "LIVE" ? <span className="wsc-tag live"><b />LIVE</span> : <span className="wsc-tag demo">DEMO</span>}
            </div>
            <div className="wsc-row">
              <span className={`wsc-ta ${sell ? "sell" : "buy"}`}><span className="s"><svg className="wsc-tri" viewBox="0 0 10 9" aria-hidden="true"><path d={sell ? "M0,0 H10 L5,9Z" : "M5,0 L10,9 H0Z"} fill="currentColor" /></svg>{sell ? "SELL" : "BUY"}</span><span className="l">{trade.lots} lot</span></span>
              <span className="wsc-sym">{trade.symbol}</span>
            </div>
            <div className="wsc-big" style={{ color: col, fontSize: bigSize }}>{hero.big}</div>
            <div className="wsc-sub" style={{ color: col }}>{hero.sub}</div>
            <div className="wsc-stats" hidden={!opt.price}>
              <div><small>ENTRY</small><b>{fmt(trade.entry)}</b></div><div><small>CURRENT</small><b>{fmt(trade.current)}</b></div><div><small>LOTS</small><b>{trade.lots}</b></div>
            </div>
          </div>
          <div className="wsc-disc">Trading involves risk. Past performance is not indicative of future results. Leverage can amplify losses.</div>
          <div className={`wsc-foot${p.me?.referralCode ? "" : " wide"}`}><span>{`Account ${maskedAccount(p.accountNumber)} \u00b7 ${stamp}`}</span></div>
          {p.me?.referralCode && p.me.qr ? (
            <div className="wsc-ref">
              <div><small>REFERRAL CODE</small><b>{p.me.referralCode}</b><span>{p.domain}</span></div>
              {/* eslint-disable-next-line @next/next/no-img-element -- QR of the client's register link */}
              <div className="wsc-qr"><img src={p.me.qr} alt="" /></div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="wsc-navs">
        <button className="wsc-nav" type="button" aria-label="Previous avatar" onClick={() => step(-1)}>{"\u2039"}</button>
        <span className="wsc-name">{slide ? slideName(slide) : ""}</span>
        <button className="wsc-nav" type="button" aria-label="Next avatar" onClick={() => step(1)}>{"\u203a"}</button>
      </div>
      <div className="wsc-dots">{slides.map((_, j) => <span key={j} className={j === i ? "on" : ""} />)}</div>
      <div className="wsc-opts">
        <h3>Display options</h3>
        <div className="boxes">
          {([["nick", "User nickname"], ["pnl", "PnL amount"], ["price", "Price"], ["graph", "Graph"]] as const).map(([k, label]) => (
            <label key={k}><input type="checkbox" checked={opt[k]} onChange={(e) => setOpt((o) => ({ ...o, [k]: e.target.checked }))} />{label}</label>
          ))}
        </div>
      </div>
      <div className="wsc-actions">
        <button type="button" className="wsc-act primary" onClick={() => void download()}><Ico d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" />Download</button>
        <button type="button" className="wsc-act" onClick={() => void copyLink()}><Ico d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />{copied ? "Copied" : "Copy link"}</button>
        <button type="button" className="wsc-act" onClick={() => void shareTo("telegram")}><Ico d="M21 4 3 11l6 2.5M21 4l-3.5 16-8.5-6.5M21 4 9 13.5V19l3-3.5" />Telegram</button>
        <button type="button" className="wsc-act" onClick={() => void shareTo("x")}><Ico d="M5 5l14 14M19 5 5 19" />X</button>
        <button type="button" className="wsc-act" onClick={() => void more()}><Ico d="M12 15V4m0 0L8 8m4-4 4 4M6 12v7h12v-7" />More</button>
      </div>
    </div>
  );
}

const Ico = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
