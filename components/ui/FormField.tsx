import { ReactNode } from "react";

export function FormField({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] text-[var(--text-3)]">
        {label}
      </label>
      {children}
      {error ? <p className="text-sm text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
