import { ReactNode } from "react";

type Tone = "danger" | "success" | "warning" | "info";

const toneClasses: Record<Tone, string> = {
  danger: "bg-[var(--sell-bg)] text-[var(--sell)] border-[var(--sell)]/30",
  success: "bg-[var(--buy-bg)] text-[var(--buy)] border-[var(--buy)]/30",
  warning: "bg-[var(--warn-bg)] text-[var(--warn)] border-[var(--warn)]/30",
  info: "bg-[var(--accent-bg)] text-[var(--accent)] border-[var(--accent)]/30",
};

export function Alert({ tone = "danger", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2 text-sm ${toneClasses[tone]}`}>{children}</div>;
}
