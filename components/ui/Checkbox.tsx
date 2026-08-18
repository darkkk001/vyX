import { InputHTMLAttributes } from "react";

export function Checkbox({
  label,
  className = "",
  id,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input
        id={id}
        type="checkbox"
        className={`h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-2 focus:ring-indigo-500 ${className}`}
        {...rest}
      />
      {label}
    </label>
  );
}
