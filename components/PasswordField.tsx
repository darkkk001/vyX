"use client";

import { useState } from "react";
import type { CSSProperties, InputHTMLAttributes, KeyboardEvent } from "react";
import { capsLockOn, passwordEyeLabel } from "@/lib/password-field";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "style"> & {
  /** Extra style for the input itself (the host's own look comes from className). */
  inputStyle?: CSSProperties;
  /** Style of the box that holds the input and the Caps Lock line (margins). */
  style?: CSSProperties;
};

// The one password field of the WebTrader and the client sign-in: the text is hidden by default, an eye inside the field at
// the right edge shows or hides it, and a "Caps Lock is on" line sits under the field while Caps Lock is on. One component, so
// no password input can miss either feature. Same behaviour as the native apps' shared PasswordBox.
export default function PasswordField({ inputStyle, style, onKeyDown, onKeyUp, onBlur, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);

  function watch(event: KeyboardEvent<HTMLInputElement>) {
    setCaps(capsLockOn((key) => event.getModifierState(key)));
  }

  return (
    <div style={style}>
      <div style={{ position: "relative" }}>
        <input
          {...rest}
          type={visible ? "text" : "password"}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", paddingRight: 38 }}
          onKeyDown={(event) => {
            watch(event);
            onKeyDown?.(event);
          }}
          onKeyUp={(event) => {
            watch(event);
            onKeyUp?.(event);
          }}
          onBlur={(event) => {
            setCaps(false);
            onBlur?.(event);
          }}
        />
        <button
          type="button"
          data-password-eye
          aria-label={passwordEyeLabel(visible)}
          title={passwordEyeLabel(visible)}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 26,
            height: 26,
            display: "grid",
            placeItems: "center",
            padding: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            opacity: 0.7,
            cursor: "pointer",
          }}
        >
          {visible ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
      {caps ? (
        <div role="status" data-caps-lock-warning style={{ marginTop: 4, fontSize: 11, color: "var(--warn, #c97a00)" }}>
          Caps Lock is on
        </div>
      ) : null}
    </div>
  );
}
