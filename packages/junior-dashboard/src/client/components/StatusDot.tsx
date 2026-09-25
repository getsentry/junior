import { cn } from "../styles";
import type { StatusChipTone } from "./StatusChip";

const toneClass: Record<StatusChipTone, string> = {
  accent: "bg-violet-300",
  danger: "bg-rose-300",
  info: "bg-cyan-300",
  neutral: "bg-white/30",
  success: "bg-emerald-300",
  warning: "bg-amber-300",
};

/** Render a compact status color marker with an accessible text label. */
export function StatusDot(props: {
  className?: string;
  label: string;
  tone?: StatusChipTone;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center", props.className)}
      title={props.label}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          toneClass[props.tone ?? "neutral"],
        )}
      />
      <span className="sr-only">{props.label}</span>
    </span>
  );
}
