import { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "success" | "ghost";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  primary: "bg-[var(--accent)] text-white hover:brightness-110 disabled:opacity-40",
  secondary:
    "bg-[var(--bg-3)] text-[var(--text-1)] border border-[var(--border-strong)] hover:border-[var(--text-3)] disabled:opacity-40",
  danger: "bg-[var(--sell-bg)] text-[var(--sell)] border border-[var(--sell)]/30 hover:brightness-125 disabled:opacity-40",
  success: "bg-[var(--buy-bg)] text-[var(--buy)] border border-[var(--buy)]/30 hover:brightness-125 disabled:opacity-40",
  ghost: "text-[var(--text-2)] hover:bg-[var(--bg-3)] disabled:opacity-40",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {children}
    </button>
  );
}
