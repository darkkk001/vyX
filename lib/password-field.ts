// Pure helpers of components/PasswordField.tsx (the one password field of the WebTrader and the client sign-in).

/** Caps Lock is on when the keyboard event reports the modifier. `state` is the event's getModifierState. */
export function capsLockOn(state: (key: "CapsLock") => boolean): boolean {
  try {
    return state("CapsLock") === true;
  } catch {
    return false;
  }
}

/** The eye's label: it names what a click does. */
export function passwordEyeLabel(visible: boolean): string {
  return visible ? "Hide password" : "Show password";
}
