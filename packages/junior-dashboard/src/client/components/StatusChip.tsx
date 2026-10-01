import type { ReactNode } from "react";

import { cn } from "../styles";

export type StatusChipTone =
  | "neutral"
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "accent";

export type StatusChipSize = "default" | "compact";

const toneClass: Record<StatusChipTone, string> = {
  accent: "text-violet-300",
  danger: "text-rose-300",
  info: "text-cyan-300",
  neutral: "text-dashboard-text-muted",
  success: "text-emerald-300",
  warning: "text-amber-300",
};

const sizeClass: Record<StatusChipSize, string> = {
  compact: "text-xs",
  default: "text-sm",
};

/** Show status as quiet text, not a button-shaped badge. */
export function StatusChip(props: {
  children: ReactNode;
  className?: string;
  size?: StatusChipSize;
  tone?: StatusChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 font-sans font-medium normal-case leading-snug tracking-normal",
        sizeClass[props.size ?? "default"],
        toneClass[props.tone ?? "neutral"],
        props.className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      <span className="block first-letter:uppercase">{props.children}</span>
    </span>
  );
}
