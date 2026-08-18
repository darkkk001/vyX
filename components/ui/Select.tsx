import { SelectHTMLAttributes, forwardRef } from "react";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = "", children, ...rest },
  ref
) {
  return (
    <select
      ref={ref}
      className={`w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--text-1)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
});
