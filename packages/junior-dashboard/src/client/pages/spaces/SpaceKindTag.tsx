import type { ConversationKindReport } from "@sentry/junior/api/schema";
import { Bug, CircleHelp, ListChecks, Search, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../styles";

const kindPresentation: Record<
  ConversationKindReport,
  { label: string; Icon: typeof Bug; className: string; accent: string }
> = {
  bug: {
    label: "Bug",
    Icon: Bug,
    className: "border-rose-300/25 bg-rose-300/10 text-rose-200",
    accent: "before:bg-rose-300/70",
  },
  feature: {
    label: "Feature",
    Icon: Sparkles,
    className: "border-violet-300/25 bg-violet-300/10 text-violet-200",
    accent: "before:bg-violet-300/70",
  },
  question: {
    label: "Question",
    Icon: CircleHelp,
    className: "border-cyan-300/25 bg-cyan-300/10 text-cyan-200",
    accent: "before:bg-cyan-300/70",
  },
  investigation: {
    label: "Investigation",
    Icon: Search,
    className: "border-amber-300/25 bg-amber-300/10 text-amber-200",
    accent: "before:bg-amber-300/70",
  },
  task: {
    label: "Task",
    Icon: ListChecks,
    className: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
    accent: "before:bg-emerald-300/70",
  },
};

/** Left edge color that marks a card with its kind of work. */
export function spaceKindAccentClass(
  kind: ConversationKindReport | null,
): string | undefined {
  return kind ? kindPresentation[kind].accent : undefined;
}

/** Tinted pill for the kind of work a Conversation was. */
export function SpaceKindTag(props: {
  count?: number;
  kind: ConversationKindReport;
}) {
  const presentation = kindPresentation[props.kind];
  const Icon = presentation.Icon;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 font-sans text-2xs font-medium leading-none",
        presentation.className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {presentation.label}
      {props.count !== undefined ? (
        <span className="font-mono opacity-70">{props.count}</span>
      ) : null}
    </span>
  );
}

/** Neutral pill for channels, repositories, and other Space facts. */
export function SpacePill(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-0 max-w-60 shrink-0 items-center gap-1 truncate rounded-full border border-white/10 bg-dashboard-control px-2 font-sans text-2xs leading-none text-dashboard-text-muted",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}
