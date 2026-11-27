import type { OwnedObjectAnnotation } from "@sentry/junior/api/schema";

import { DisplayText } from "../display-text/DisplayText";
import { cn } from "../styles";
import type { Conversation } from "../types";
import { InboxItemObjects } from "./InboxItemObjects";

/** The second line: the summary, or the newest message when there is none. */
export function rowSummary(conversation: Conversation | undefined) {
  if (conversation?.summary)
    return { mentions: undefined, text: conversation.summary };
  const preview = conversation?.activityPreview;
  if (!preview) return undefined;
  return { mentions: preview.mentions, text: preview.text };
}

/**
 * A row's summary line. A closed row clamps it to one line, or two when
 * comfortable; an open row shows all of it.
 */
export function RowSummary(props: {
  comfortable: boolean;
  conversationId: string | undefined;
  expanded: boolean;
  /** The row's linked work, so the summary's links show their chips. */
  objects: readonly OwnedObjectAnnotation[];
  summary: NonNullable<ReturnType<typeof rowSummary>>;
}) {
  return (
    <div
      className="flex min-w-0 text-sm leading-snug text-dashboard-text-muted"
      data-summary-lines={
        props.expanded ? "all" : props.comfortable ? "2" : "1"
      }
    >
      <div
        className={cn(
          "min-w-0",
          props.expanded
            ? "line-clamp-none"
            : props.comfortable
              ? "line-clamp-2"
              : "line-clamp-1",
        )}
      >
        {/* As messages show it: links show as chips, so the clamp ends on
            a word or a chip, not inside a URL. One line runs the
            paragraphs together; more lines keep them. */}
        <InboxItemObjects
          cards={props.objects}
          conversationId={props.conversationId}
        >
          <DisplayText
            chips
            inline
            mentions={props.summary.mentions}
            paragraphs={props.expanded || props.comfortable}
            text={props.summary.text}
          />
        </InboxItemObjects>
      </div>
    </div>
  );
}
