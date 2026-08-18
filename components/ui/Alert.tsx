import { ReactNode } from "react";

type Tone = "danger" | "success" | "warning" | "info";

const toneClasses: Record<Tone, string> = {
  danger: "bg-rose-50 text-rose-700 border-rose-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  info: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

export function Alert({ tone = "danger", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2 text-sm ${toneClasses[tone]}`}>{children}</div>;
}
