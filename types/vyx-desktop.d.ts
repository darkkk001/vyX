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
    };
  }
}
