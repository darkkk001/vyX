"use client";

import { useSyncExternalStore } from "react";

// Same breakpoint as room.css. The server renders the desktop header; room.css keeps that from showing on a phone.
const QUERY = "(max-width: 768px)";
const subscribe = (fn: () => void) => {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
};
export const useIsMobile = () => useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
