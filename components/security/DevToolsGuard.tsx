"use client";

import { useEffect } from "react";

// CRM pages in production (owner 2026-11-13): no right-click menu, no F12 / Ctrl+Shift+I/J/C / Ctrl+U (and the Mac
// Cmd+Option+I/J/C, Cmd+U), and the browser console quiet. Text fields keep their own menu, so copy and paste work
// there as before (Ctrl+C / Ctrl+V are never touched). Our own right-click menus still open: only the browser's menu
// is suppressed. This makes casual inspection harder; it is not a security boundary (the server checks are).
const EDITABLE = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function blockedKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  const k = e.key.toLowerCase();
  if (k === "f12") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.shiftKey || e.altKey) && (k === "i" || k === "j" || k === "c")) return true;
  if (mod && !e.shiftKey && !e.altKey && k === "u") return true;
  return false;
}

export default function DevToolsGuard() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const onMenu = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.(EDITABLE)) return;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (blockedKey(e)) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey, true);
    // console quiet: log/info/debug/warn/trace/table/dir do nothing (console.error stays for real crashes)
    const c = console as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const m of ["log", "info", "debug", "warn", "trace", "table", "dir", "dirxml", "group", "groupCollapsed"]) {
      saved[m] = c[m];
      c[m] = () => {};
    }
    return () => {
      document.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("keydown", onKey, true);
      for (const m of Object.keys(saved)) c[m] = saved[m];
    };
  }, []);
  return null;
}
