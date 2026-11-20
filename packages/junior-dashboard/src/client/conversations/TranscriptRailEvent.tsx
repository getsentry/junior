import { createContext, useContext, type ReactNode } from "react";
import type { ObjectType } from "@sentry/junior-plugin-api";
import { ObjectIcon } from "../components/ObjectIcon";
import {
  Activity,
  Brain,
  Calendar,
  Check,
  Database,
  Info,
  KeyRound,
  Link,
  MessageSquareText,
  MessagesSquare,
  Minimize2,
  Paperclip,
  Sparkles,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../styles";
import type { TranscriptViewStructuredEventPart } from "../types";
import { transcriptColumnsClass } from "./TranscriptRows";

type TranscriptRailEventKind =
  | "attachments_delivered"
  | "compaction"
  | "message_context"
  | "event"
  | "structured_event"
  | "thread";

/**
 * True inside an activity group. Grouped rows use the narrow activity icon
 * column. Top-level rows put the icon in the avatar column, so their text
 * lines up with message text.
 */
export const TranscriptActivityNesting = createContext(false);

/** Mark noteworthy transcript events with an inline status icon. */
export function TranscriptRailEvent(props: {
  children: ReactNode;
  icon?: LucideIcon;
  objectType?: ObjectType | undefined;
  kind: TranscriptRailEventKind;
}) {
  const marker = transcriptRailMarker(props.kind);
  const Icon = props.icon ?? marker.icon;
  const nested = useContext(TranscriptActivityNesting);

  return (
    <div
      className={cn(
        "grid min-w-0 items-start",
        nested
          ? "grid-cols-[1rem_minmax(0,1fr)] gap-2"
          : transcriptColumnsClass,
      )}
      data-transcript-rail-event={props.kind}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid h-6 place-items-center",
          // Card rows: center the icon on the card's first line.
          !nested &&
            (props.kind === "thread" || props.kind === "message_context") &&
            "mt-1.5",
          marker.className,
        )}
      >
        {props.objectType ? (
          <ObjectIcon objectType={props.objectType} size={14} decorative />
        ) : (
          <Icon size={nested ? 14 : 15} strokeWidth={2} />
        )}
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
  if (kind === "event") {
    return {
      className: "text-violet-200",
      icon: Webhook,
    };
  }
  if (kind === "attachments_delivered") {
    return {
      className: "text-dashboard-text-muted",
      icon: Paperclip,
    };
  }
  if (kind === "structured_event") {
    return {
      className: "text-violet-200",
      icon: Activity,
    };
  }
  if (kind === "thread") {
    return {
      className: "text-cyan-200",
      icon: MessagesSquare,
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
