// Shared transport layer for every bundled desktop shell (desktop-tauri's
// webtrader-shell/, manager-tauri's manager-shell/, and admin-tauri's
// admin-shell/ once it exists) -- originally lived only in
// lib/trade-api.ts, extracted here once manager-shell needed the exact
// same transport branching against a different cookie/session (Manager's
// vyx_admin_session, not the Trader terminal's vyx_trade_session) but
// identical mechanics: a bundled shell's own fetch()/FormData can't carry
// an httpOnly session cookie across the local-content/real-host origin
// boundary, so window.vyxDesktop.apiCall/apiCallMultipart (a native
// Rust command backed by a persistent cookie-jar reqwest::Client) is the
// transport instead, when present. Every server route is unchanged
// either way -- this is a transport swap, not a protocol one. Falls back
// to plain fetch() everywhere `window.vyxDesktop` isn't set (the live
// website, and any desktop build without this bridge).

// Used nowhere near auth but relied on by client-side candle bucketing
// (lib/market-simulator.ts's applyBidAsk) to decide when a new candle
// starts. A skewed local clock silently misaligned live candles against
// the real, server-seeded history the moment the two met -- reported
// live as candles looking "torn." Every response carries a standard HTTP
// `Date` header for free; recalibrating from it on every API call keeps
// the correction current without a dedicated endpoint or timer of its own.
let serverTimeOffsetMs = 0;
export function serverNow(): number {
  return Date.now() + serverTimeOffsetMs;
}
function recalibrateFromDateHeader(header: string | null | undefined) {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isFinite(serverMs)) serverTimeOffsetMs = serverMs - Date.now();
}
function recalibrateFromResponse(response: Response) {
  recalibrateFromDateHeader(response.headers.get("date"));
}

export async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const desktop = typeof window !== "undefined" ? window.vyxDesktop : undefined;
  if (desktop?.apiCall) {
    const parsedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const { status, body, date } = await desktop.apiCall(path, init?.method ?? "GET", parsedBody);
    recalibrateFromDateHeader(date);
    if (status < 200 || status >= 300) {
      throw new Error((body as { error?: string } | null)?.error ?? `request to ${path} failed (${status})`);
    }
    return body as T;
  }

  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  recalibrateFromResponse(response);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? `request to ${path} failed (${response.status})`);
  }
  return body as T;
}

// btoa() only accepts a binary string, not raw bytes -- chunked to avoid
// blowing the call stack on String.fromCharCode(...bytes) for a
// multi-megabyte file.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Same as apiCall(), minus the forced JSON content-type -- a FormData
// body needs the browser to set its own multipart boundary, which an
// explicit Content-Type header would override and break. The desktop
// path can't hand a browser FormData/File object to Rust at all, so it
// re-encodes each part as a plain JSON-safe field first -- see
// window.vyxDesktop.apiCallMultipart's own doc comment.
export async function apiCallForm<T>(path: string, body: FormData): Promise<T> {
  const desktop = typeof window !== "undefined" ? window.vyxDesktop : undefined;
  if (desktop?.apiCallMultipart) {
    const fields: Array<
      | { name: string; value: string }
      | { name: string; file: { filename: string; mime: string; dataBase64: string } }
    > = [];
    for (const [name, value] of body.entries()) {
      if (value instanceof File) {
        const dataBase64 = arrayBufferToBase64(await value.arrayBuffer());
        fields.push({ name, file: { filename: value.name, mime: value.type || "application/octet-stream", dataBase64 } });
      } else {
        fields.push({ name, value });
      }
    }
    const { status, body: responseBody } = await desktop.apiCallMultipart(path, fields);
    if (status < 200 || status >= 300) {
      throw new Error((responseBody as { error?: string } | null)?.error ?? `request to ${path} failed (${status})`);
    }
    return responseBody as T;
  }

  const response = await fetch(path, { method: "POST", body });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(responseBody?.error ?? `request to ${path} failed (${response.status})`);
  }
  return responseBody as T;
}
