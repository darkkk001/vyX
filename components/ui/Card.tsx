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
    <div className={`rounded-lg border border-slate-200 bg-white p-6 shadow-sm ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
