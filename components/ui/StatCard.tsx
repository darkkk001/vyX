import { ReactNode } from "react";

const deltaToneClasses = {
  pos: "text-[var(--buy)]",
  neg: "text-[var(--sell)]",
  warn: "text-[var(--warn)]",
  neutral: "text-[var(--text-3)]",
} as const;

export function StatCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  valueTone,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: keyof typeof deltaToneClasses;
  valueTone?: "warn";
}) {
  return (
    <div className="rounded-[11px] border border-[var(--border)] bg-[var(--bg-1)] p-4">
      <p className="mb-2 text-[11px] text-[var(--text-3)]">{label}</p>
      <p
        className="font-mono text-[22px] font-bold text-[var(--text-1)]"
        style={valueTone === "warn" ? { color: "var(--warn)" } : undefined}
      >
        {value}
      </p>
      {delta ? <p className={`mt-1.5 text-[11px] font-medium ${deltaToneClasses[deltaTone]}`}>{delta}</p> : null}
    </div>
  );
}

export function StatGrid({ columns = 5, children }: { columns?: number; children: ReactNode }) {
  return (
    <div
      className="mb-[22px] grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {children}
    </div>
  );
}
