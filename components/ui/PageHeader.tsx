import { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-[18px] flex items-start justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text-1)]">{title}</h1>
        {description ? <p className="mt-0.5 text-xs text-[var(--text-3)]">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
