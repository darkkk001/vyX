import { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-slate-50">
      <tr>{children}</tr>
    </thead>
  );
}

const alignClasses = { left: "text-left", right: "text-right", center: "text-center" } as const;

export function TableHeaderCell({
  align = "left",
  className = "",
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      className={`border-b border-slate-200 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 ${alignClasses[align]} ${className}`}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TableRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <tr className={`hover:bg-slate-50 ${className}`}>{children}</tr>;
}

export function TableCell({
  align = "left",
  mono = false,
  className = "",
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: "left" | "right" | "center"; mono?: boolean }) {
  return (
    <td
      className={`px-4 py-2.5 text-slate-700 ${alignClasses[align]} ${mono ? "font-mono" : ""} ${className}`}
      {...rest}
    >
      {children}
    </td>
  );
}

export function TableEmptyState({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-8 text-center text-sm text-slate-400">
        {children}
      </td>
    </tr>
  );
}
