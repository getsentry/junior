import {
  CircleCheck,
  CircleHelp,
  Eye,
  Info,
  Stamp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../styles";

type AskLook = {
  icon: LucideIcon;
  /** The pill's fill when the ask waits on the viewer. */
  tint: string;
  /** The icon's color, readable on both themes. */
  tone: string;
};

// One look per kind of ask, so a row scans by icon and color before its
// words. The kind's name stays in the accessible name and the tooltip, so
// color is never the only signal.
const ASK_LOOKS: Record<string, AskLook> = {
  Approval: {
    icon: Stamp,
    tint: "bg-amber-500/12",
    tone: "text-amber-600 dark:text-amber-300",
  },
  FYI: {
    icon: Info,
    tint: "bg-dashboard-fill-soft",
    tone: "text-dashboard-text-muted",
  },
  Question: {
    icon: CircleHelp,
    tint: "bg-violet-500/12",
    tone: "text-violet-600 dark:text-violet-300",
  },
  "Ready to merge": {
    icon: CircleCheck,
    tint: "bg-emerald-500/12",
    tone: "text-emerald-600 dark:text-emerald-300",
  },
  "Review requested": {
    icon: Eye,
    tint: "bg-sky-500/12",
    tone: "text-sky-600 dark:text-sky-300",
  },
};

/** The icon and colors of a kind of ask, such as "Ready to merge". */
export function askLook(kind: string): AskLook | undefined {
  return ASK_LOOKS[kind];
}

/**
 * The icon of a kind of ask, in its color. A kind with no look, such as a
 * closed item's status, shows nothing. With `label`, the icon is an image
 * named for its kind; without it, the text next to it names the kind.
 */
export function AskKindIcon(props: {
  className?: string;
  kind: string;
  label?: boolean;
}) {
  const look = askLook(props.kind);
  if (!look) return null;
  const Icon = look.icon;
  return (
    <Icon
      aria-hidden={props.label ? undefined : "true"}
      aria-label={props.label ? props.kind : undefined}
      className={cn("size-3.5 shrink-0", look.tone, props.className)}
      data-ask-kind={props.kind}
      role={props.label ? "img" : undefined}
    />
  );
}
