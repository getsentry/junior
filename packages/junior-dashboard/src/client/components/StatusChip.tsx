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
  accent: "border-violet-300/20 bg-violet-300/[0.07] text-violet-100",
  danger: "border-rose-400/25 bg-rose-400/10 text-rose-200",
  info: "border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-100",
  neutral: "border-white/[0.08] bg-white/[0.025] text-dashboard-text-muted",
  success: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-400/25 bg-amber-400/10 text-amber-100",
};

const sizeClass: Record<StatusChipSize, string> = {
  compact:
    "gap-1.5 px-2 py-1 font-mono text-2xs uppercase tracking-[0.08em]",
  default: "px-2 py-1 font-mono text-xs uppercase tracking-[0.1em]",
};

/** Render a compact status or kind label with shared tone and size contracts. */
export function StatusChip(props: {
  children: ReactNode;
  className?: string;
  size?: StatusChipSize;
  tone?: StatusChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded border",
        sizeClass[props.size ?? "default"],
        toneClass[props.tone ?? "neutral"],
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}
