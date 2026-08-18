import { InputHTMLAttributes, forwardRef } from "react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ mono = false, className = "", ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 ${mono ? "font-mono" : ""} ${className}`}
        {...rest}
      />
    );
  }
);
