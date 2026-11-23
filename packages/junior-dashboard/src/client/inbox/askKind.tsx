import {
  CircleCheck,
  CircleHelp,
  Eye,
  GitMerge,
  Info,
  ListTodo,
  Stamp,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../styles";

// One icon per kind of ask, so a row scans by shape before its words. The
// icons share the muted text color: the kind is not a status. An ask pill
// also shows the kind's name next to its icon.
const ASK_ICONS: Record<string, LucideIcon> = {
  Approval: Stamp,
  FYI: Info,
  Question: CircleHelp,
  // A code change row's state pill; its item is a Question by kind.
  "Merge conflict": GitMerge,
  "Ready to merge": CircleCheck,
  "Review requested": Eye,
  "To do for you": ListTodo,
};

/** The icon of a kind of ask, such as "Ready to merge". */
export function askIcon(kind: string): LucideIcon | undefined {
  return ASK_ICONS[kind];
}

/**
 * The icon of a kind of ask. A kind with no icon, such as a closed item's
 * status, shows nothing. With `label`, the icon is an image named for its
 * kind; without it, the text next to it names the kind.
 */
export function AskKindIcon(props: {
  className?: string;
  kind: string;
  label?: boolean;
}) {
  const Icon = ASK_ICONS[props.kind];
  if (!Icon) return null;
  return (
    <Icon
      aria-hidden={props.label ? undefined : "true"}
      aria-label={props.label ? props.kind : undefined}
      className={cn(
        "size-3.5 shrink-0 text-dashboard-text-muted",
        props.className,
      )}
      data-ask-kind={props.kind}
      role={props.label ? "img" : undefined}
    />
  );
}
