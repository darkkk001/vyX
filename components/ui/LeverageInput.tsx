import { InputHTMLAttributes, forwardRef } from "react";

// Leverage is always stored/edited as the bare ratio denominator (e.g.
// 100, 500 -- see Group.leverage/Account.leverage/Broker.defaultAccountLeverage,
// all plain Int), but every real trading platform displays it as "1:100",
// never a bare number -- a bare "100" reads as meaningless to anyone
// used to MT4/MT5. This shows a fixed "1:" prefix inside the same input
// chrome as Input.tsx (border/bg/focus ring moved to the wrapper, via
// focus-within, since the boundary is now shared with the prefix) while
// still only ever submitting/storing the bare number typed after it.
export const LeverageInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function LeverageInput({ className = "", disabled, ...rest }, ref) {
    return (
      <div
        className={`flex items-center rounded-lg border border-[var(--border)] bg-[var(--bg-2)] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_rgba(30,217,144,0.12)] ${disabled ? "opacity-50" : ""} ${className}`}
      >
        <span className="pl-3 font-mono text-sm text-[var(--text-3)]">1:</span>
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          disabled={disabled}
          className="w-full min-w-0 bg-transparent py-2 pl-1 pr-3 font-mono text-sm text-[var(--text-1)] outline-none disabled:cursor-not-allowed"
          {...rest}
        />
      </div>
    );
  }
);
