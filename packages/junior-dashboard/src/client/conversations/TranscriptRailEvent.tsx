import type { ReactNode } from "react";
import {
  Activity,
  Bot,
  Brain,
  Calendar,
  Check,
  Database,
  Diff,
  Info,
  KeyRound,
  Link,
  MessageSquareText,
  Minimize2,
  Send,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../styles";
import type { TranscriptViewStructuredEventPart } from "../types";

type TranscriptRailEventKind =
  | "compaction"
  | "handoff"
  | "message_context"
  | "resource_event"
  | "structured_event"
  | "subagent";

/** Mark noteworthy transcript events with an inline status icon. */
export function TranscriptRailEvent(props: {
  children: ReactNode;
  icon?: LucideIcon;
  kind: TranscriptRailEventKind;
}) {
  const marker = transcriptRailMarker(props.kind);
  const Icon = props.icon ?? marker.icon;

  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2"
      data-transcript-rail-event={props.kind}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-1.5 grid size-5 place-items-center rounded bg-black/30",
          marker.className,
        )}
      >
        <Icon size={11} strokeWidth={2.2} />
      </span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

function transcriptRailMarker(kind: TranscriptRailEventKind): {
  className: string;
  icon: LucideIcon;
} {
  if (kind === "message_context") {
    return {
      className: "text-dashboard-text-muted",
      icon: MessageSquareText,
    };
  }
  if (kind === "resource_event") {
    return {
      className: "text-violet-200",
      icon: Diff,
    };
  }
  if (kind === "structured_event") {
    return {
      className: "text-violet-200",
      icon: Activity,
    };
  }
  if (kind === "subagent") {
    return {
      className: "text-cyan-200",
      icon: Bot,
    };
  }
  if (kind === "handoff") {
    return {
      className: "text-sky-200",
      icon: Send,
    };
  }
  return {
    className: "text-amber-200",
    icon: Minimize2,
  };
}

const structuredEventIcons: Record<
  NonNullable<TranscriptViewStructuredEventPart["presentation"]["icon"]>,
  LucideIcon
> = {
  activity: Activity,
  brain: Brain,
  calendar: Calendar,
  check: Check,
  database: Database,
  info: Info,
  key: KeyRound,
  link: Link,
  sparkles: Sparkles,
  warning: TriangleAlert,
};

/** Resolve the structured-event presentation icon for the transcript rail. */
export function structuredEventIcon(
  icon: TranscriptViewStructuredEventPart["presentation"]["icon"],
): LucideIcon {
  return icon ? structuredEventIcons[icon] : Activity;
}
