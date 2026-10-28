import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../styles";

const selectClassName = {
  form: "min-h-11 rounded-md border border-dashboard-border-emphasis bg-dashboard-ink pl-3 py-2 text-base text-dashboard-text focus:border-dashboard-focus focus:outline-none aria-invalid:border-rose-300 sm:min-h-10 sm:text-sm",
  filter:
    "h-9 rounded-lg border border-dashboard-border-emphasis bg-dashboard-control pl-2 text-sm text-dashboard-text transition-colors hover:border-dashboard-border-interactive focus:border-dashboard-focus focus:outline-none focus:ring-1 focus:ring-dashboard-focus/25",
  sort: "h-full bg-dashboard-control pl-2 font-sans text-xs text-dashboard-text-muted outline-none",
};

/** Keep native choices and position their arrow consistently across the dashboard. */
export function Select({
  className,
  variant = "form",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  variant?: keyof typeof selectClassName;
}) {
  const showArrow = !props.multiple && (props.size ?? 1) <= 1;

  return (
    <span
      className={cn(
        "relative block w-full min-w-0",
        variant === "sort" && "h-full",
      )}
    >
      <select
        {...props}
        className={cn(
          "block w-full min-w-0 disabled:cursor-not-allowed disabled:opacity-60 [color-scheme:var(--dashboard-color-scheme,dark)]",
          selectClassName[variant],
          showArrow
            ? "appearance-none pr-9 forced-colors:appearance-auto"
            : "pr-3",
          className,
        )}
      />
      {showArrow ? (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dashboard-text-muted forced-colors:hidden",
            props.disabled && "opacity-60",
          )}
          size={16}
        />
      ) : null}
    </span>
  );
}
