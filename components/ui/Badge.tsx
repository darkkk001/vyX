import { ReactNode } from "react";

type Tone = "success" | "danger" | "warning" | "neutral" | "info";

const toneClasses: Record<Tone, string> = {
  success: "bg-emerald-50 text-emerald-700",
  danger: "bg-rose-50 text-rose-700",
  warning: "bg-amber-50 text-amber-700",
  neutral: "bg-slate-100 text-slate-600",
  info: "bg-indigo-50 text-indigo-700",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${toneClasses[tone]}`}>
      {children}
    </span>
  );
}
