// Global hotkey manager for Smart Trade Manager's Smart Execution mode
// (see components/webtrader/SmartTradeManager.tsx). Deliberately small --
// this is a keydown listener + a lookup table, not a general-purpose
// hotkey library, since that's all Smart Execution actually needs.

export type HotkeyModifiers = { ctrl: boolean; alt: boolean; shift: boolean };

export type HotkeyBinding = { key: string; ctrl: boolean; alt: boolean; shift: boolean };

// Canonical string form used both as the lookup-table key and as the
// user-facing label ("Ctrl+1") -- keeping these the same avoids a
// separate formatting function silently drifting from the matching logic.
export function hotkeyToLabel(binding: HotkeyBinding | null): string {
  if (!binding) return "Unassigned";
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join("+");
}

export function eventToBinding(e: KeyboardEvent): HotkeyBinding {
  return { key: e.key, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey };
}

export function bindingsEqual(a: HotkeyBinding | null, b: HotkeyBinding | null): boolean {
  if (!a || !b) return a === b;
  return a.key.toLowerCase() === b.key.toLowerCase() && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

// A keypress while focus is inside a text input/textarea/select or a
// contentEditable element is never a trading hotkey -- typing "1" into
// the lot-size field must type "1", not fire a Buy hotkey. This is the
// single most important safety check in this module.
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export type HotkeyHandlerMap = Record<string, () => void>;

// Registers one document-level keydown listener and dispatches to
// whichever handler's binding matches -- one listener total regardless of
// how many hotkeys are configured, so there's exactly one place that
// enforces the isTypingTarget guard rather than N independent ones.
export function registerHotkeys(
  bindings: { binding: HotkeyBinding | null; handler: () => void }[],
  enabled: boolean
): () => void {
  function onKeyDown(e: KeyboardEvent) {
    if (!enabled) return;
    if (isTypingTarget(e.target)) return;
    const pressed = eventToBinding(e);
    for (const { binding, handler } of bindings) {
      if (binding && bindingsEqual(binding, pressed)) {
        e.preventDefault();
        handler();
        return;
      }
    }
  }
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
}

// Two configured hotkeys resolving to the exact same key+modifier combo
// would make one of them silently unreachable -- caught at assignment
// time (the STM settings UI calls this before saving), not at press time.
export function findConflict(
  candidate: HotkeyBinding,
  existing: { label: string; binding: HotkeyBinding | null }[]
): string | null {
  const hit = existing.find((e) => e.binding && bindingsEqual(e.binding, candidate));
  return hit ? hit.label : null;
}
