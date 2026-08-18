import { ReactNode } from "react";

type Tone = "success" | "danger" | "warning" | "neutral" | "info" | "accent";

const toneClasses: Record<Tone, string> = {
  success: "bg-[var(--buy-bg)] text-[var(--buy)]",
  danger: "bg-[var(--sell-bg)] text-[var(--sell)]",
  warning: "bg-[var(--warn-bg)] text-[var(--warn)]",
  neutral: "bg-[var(--bg-3)] text-[var(--text-3)]",
  info: "bg-[var(--bg-3)] text-[var(--text-2)]",
  // Resolves green under /manage/* and purple under /(super-admin)/* since
  // it's the shared --accent/--accent-bg token pair (see app/admin-theme.css).
  accent: "bg-[var(--accent-bg)] text-[var(--accent)]",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}
