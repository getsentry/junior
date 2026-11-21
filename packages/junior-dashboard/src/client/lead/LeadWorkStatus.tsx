import { Check, CircleAlert, Hand, LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../styles";
import type { LeadWorkState } from "./leadWork";

/** Label, icon, and colors of each Lead state. */
export const leadWorkStatus: Record<
  LeadWorkState,
  {
    dot: string;
    icon: LucideIcon;
    label: string;
    text: string;
    tile: string;
  }
> = {
  done: {
    dot: "bg-zinc-400",
    icon: Check,
    label: "Done",
    text: "text-zinc-400",
    tile: "bg-zinc-400/10 text-zinc-400",
  },
  failed: {
    dot: "bg-red-400",
    icon: CircleAlert,
    label: "Failed",
    text: "text-red-400",
    tile: "bg-red-400/10 text-red-400",
  },
  needs_you: {
    dot: "bg-amber-400",
    icon: Hand,
    label: "Needs you",
    text: "text-amber-400",
    tile: "bg-amber-400/10 text-amber-400",
  },
  working: {
    dot: "bg-cyan-400",
    icon: LoaderCircle,
    label: "Working",
    text: "text-cyan-400",
    tile: "bg-cyan-400/10 text-cyan-400",
  },
};

/** Show a Lead state as a small tinted tile with its icon. */
export function LeadWorkTile(props: {
  className?: string;
  state: LeadWorkState;
}) {
  const status = leadWorkStatus[props.state];
  const Icon = status.icon;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-[1.875rem] shrink-0 place-items-center rounded-md",
        status.tile,
        props.className,
      )}
    >
      <Icon
        className={cn(
          "size-4",
          props.state === "working" &&
            "animate-spin [animation-duration:2s] motion-reduce:animate-none",
        )}
        strokeWidth={2}
      />
    </span>
  );
}

/** Show a Lead state as a colored dot and its label. */
export function LeadWorkLabel(props: { state: LeadWorkState }) {
  const status = leadWorkStatus[props.state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-sans text-xs font-medium",
        status.text,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", status.dot)}
      />
      {status.label}
    </span>
  );
}
