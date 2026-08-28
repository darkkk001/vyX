// Exposed by a Tauri desktop shell's init script when running inside one
// -- absent in a normal browser tab. Different shells implement different
// subsets: desktop-tauri (frameless, custom title bar) implements the
// full set including window controls; manager-tauri (OS-decorated
// window, no custom title bar -- see its own main.rs doc comment)
// implements only isDesktop/rememberBroker/forgetBroker, since the OS
// already provides real minimize/maximize/close for a decorated window.
// Every field but isDesktop is optional so each shell's actual subset
// type-checks without the others needing to fake support they don't have.
export {};

declare global {
  interface Window {
    vyxDesktop?: {
      isDesktop: true;
      minimize?: () => void;
      toggleMaximize?: () => void;
      close?: () => void;
      onMaximizedChange?: (cb: (isMaximized: boolean) => void) => () => void;
      rememberBroker?: (hostname: string) => void;
      forgetBroker?: () => void;
      // The real broker hostname (e.g. "acmefx.vyxtrader.com"), set only by
      // a bundled shell whose own document isn't served from that host --
      // see WebTrader.tsx's two window.location.hostname call sites.
      brokerHost?: string;
      // Present only in a bundled shell (desktop-tauri's Rust api_request/
      // api_request_multipart commands) -- lib/trade-api.ts's call()/
      // callForm() use these instead of fetch() when set, since the
      // WebView's own fetch()/FormData can't carry the broker's httpOnly
      // session cookie across the local-content/real-host origin boundary.
      apiCall?: (
        path: string,
        method: string,
        body: unknown
      ) => Promise<{ status: number; body: unknown; date: string | null }>;
      apiCallMultipart?: (
        path: string,
        fields: Array<
          | { name: string; value: string }
          | { name: string; file: { filename: string; mime: string; dataBase64: string } }
        >
      ) => Promise<{ status: number; body: unknown; date: string | null }>;
      // Present only in desktop-tauri (Phase 4) -- starts/stops the two
      // native WS relays (price ticks, trading events) that replace
      // WebTrader.tsx's own browser WebSocket connections when bundled,
      // since a browser WebSocket can't carry the session cookie across
      // the local-content/real-host origin boundary but a raw Rust
      // handshake can. startLiveStreams should only be called once a
      // session is known to exist (right after login/on a valid mount).
      startLiveStreams?: () => Promise<void>;
      stopLiveStreams?: () => void;
      onPriceTick?: (cb: (payload: string) => void) => () => void;
      onTradingEvent?: (cb: (payload: string) => void) => () => void;
    };
  }
}
