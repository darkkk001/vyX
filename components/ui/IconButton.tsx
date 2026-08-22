import { ButtonHTMLAttributes } from "react";

// Small square icon-only button for row actions (e.g. "Modify", "Edit") --
// extracted from the inline pattern PositionsManager.tsx already used,
// since every other page hand-rolled its own version or fell back to a
// full text Button, both less compact than the reference design's
// .icon-btn. Matches that reference's exact sizing/colors.
export function IconButton({
  title,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[7px] border border-[var(--border-strong)] bg-[var(--bg-3)] text-[var(--text-2)] transition-colors hover:border-[var(--text-3)] hover:bg-[var(--bg-4)] hover:text-[var(--text-1)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
