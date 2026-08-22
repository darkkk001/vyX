"use client";

import { InputHTMLAttributes, forwardRef, useState } from "react";
import { Input } from "@/components/ui/Input";

// Same eye/eye-off glyphs WebTrader.tsx's balance-hide toggle already
// uses (topbar-right's eye-toggle-btn) -- reused here so a password
// field's show/hide affordance looks like the one other visibility
// toggle already in this app, not a new one-off icon.
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function PasswordInput({ className = "", ...rest }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input ref={ref} type={visible ? "text" : "password"} className={`pr-9 ${className}`} {...rest} />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          title={visible ? "Hide password" : "Show password"}
          aria-label={visible ? "Hide password" : "Show password"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-1)]"
        >
          {visible ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
    );
  }
);
