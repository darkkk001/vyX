import "server-only";
import { NextResponse } from "next/server";
import { BITMOJI_CHANNEL, BITMOJI_COOKIE, type BitmojiResult } from "@/lib/room/bitmoji";

// How a connect attempt ends (lib/room/bitmoji.ts). In the same page: back to Profile with ?bitmoji=<result>. In its
// own tab (Profile opened it after the "Connect your Bitmoji" popup): a page that tells the Profile tab the result
// (BroadcastChannel, and window.opener when Snap's pages left it), then closes itself; if the browser does not let it
// close, it shows Profile with the result instead. The attempt cookie is cleared either way.

function donePage(result: BitmojiResult): string {
  const r = JSON.stringify(result);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Bitmoji</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;background:#fff;color:#555}@media (prefers-color-scheme:dark){body{background:#111;color:#aaa}}</style>
</head><body><p>You can close this tab.</p>
<script>(function(){var r=${r};try{var c=new BroadcastChannel(${JSON.stringify(BITMOJI_CHANNEL)});c.postMessage({bitmoji:r});c.close();}catch(e){}try{if(window.opener&&window.opener!==window)window.opener.postMessage({bitmoji:r},location.origin);}catch(e){}window.close();setTimeout(function(){location.replace("/room/profile?bitmoji="+encodeURIComponent(r));},600);})();</script>
</body></html>`;
}

export function bitmojiResult(origin: string, result: BitmojiResult, tab: boolean): NextResponse {
  const res = tab
    ? new NextResponse(donePage(result), { headers: { "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" } })
    : NextResponse.redirect(`${origin}/room/profile?bitmoji=${result}`, 303);
  res.cookies.set(BITMOJI_COOKIE, "", { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax", path: "/api/bitmoji", maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
