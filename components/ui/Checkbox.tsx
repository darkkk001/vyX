import { InputHTMLAttributes } from "react";

export function Checkbox({
  label,
  className = "",
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-[var(--text-2)]">
      <input
        id={id}
        type="checkbox"
        className={`h-4 w-4 rounded border-[var(--border-strong)] accent-[var(--accent)] ${className}`}
        {...rest}
      />
      {label}
    </label>
  );
}
