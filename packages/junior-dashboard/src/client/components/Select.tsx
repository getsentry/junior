import type { SelectHTMLAttributes } from "react";
import { cn } from "../styles";

/** Match native form choices to the dashboard text controls. */
export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "block min-h-11 w-full min-w-0 rounded border border-dashboard-border-emphasis bg-dashboard-ink px-3 py-2 text-base text-dashboard-text focus:border-dashboard-focus focus:outline-none aria-invalid:border-rose-300 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-10 sm:text-sm",
        className,
      )}
    />
  );
}
