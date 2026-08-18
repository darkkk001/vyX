import { ReactNode } from "react";

export function Card({
  title,
  description,
  action,
  className = "",
  children,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title ? <h2 className="text-sm font-semibold text-[var(--text-1)]">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-[var(--text-3)]">{description}</p> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
