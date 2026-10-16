import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";

import { ConversationAutomationLink } from "./ConversationAutomationLink";
import { messageRawText } from "./transcriptRenderModel";
import { HighlightText } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import { TranscriptTurnContextView } from "./TranscriptTurnContextView";
import { cn } from "../styles";
import type { ConversationTranscript, TranscriptViewMessage } from "../types";

type SourceTask = NonNullable<ConversationDetailReport["sourceTask"]>;

/** True when a message is the trigger input of an Automation run. */
export function isAutomationTriggerMessage(
  conversation: ConversationTranscript,
  message: TranscriptViewMessage,
): boolean {
  const triggerMessageId = conversation.sourceTask?.triggerMessageId;
  return Boolean(
    triggerMessageId &&
    message.role === "user" &&
    message.messageId === triggerMessageId,
  );
}

/**
 * Render an Automation run's trigger input as a system event, not a person's
 * message. The heading links to the Automation. The task input expands.
 */
export function TranscriptAutomationTriggerView(props: {
  message: TranscriptViewMessage;
  sourceTask: SourceTask;
}) {
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const summary =
    props.sourceTask.kind === "scheduled"
      ? "Started on schedule"
      : "Started by event";
  const label = (
    <span className="min-w-0 break-words font-display text-sm font-semibold leading-6 text-dashboard-text">
      <HighlightText text={summary} />
    </span>
  );

  return (
    <div className="min-w-0 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {/* A button, not <details>, so the Automation link stays a separate control. */}
        {text ? (
          <button
            aria-controls={bodyId}
            aria-expanded={open}
            className="-mx-2 -my-1.5 flex cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-dashboard-text-muted transition-colors hover:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            {label}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "mt-1.5 size-3 shrink-0 transition-transform",
                open && "rotate-90",
              )}
              strokeWidth={2.2}
            />
          </button>
        ) : (
          label
        )}
        <ConversationAutomationLink
          className="text-xs"
          hideIcon
          sourceTask={props.sourceTask}
        />
        {props.message.contexts?.length ? (
          <TranscriptTurnContextView contexts={props.message.contexts} />
        ) : null}
      </div>
      {text && open ? (
        <pre
          className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border bg-dashboard-surface-panel px-3 py-2 font-sans text-xs leading-relaxed text-dashboard-text-muted"
          id={bodyId}
        >
          <HighlightText text={text} />
        </pre>
      ) : null}
      {!text && redacted ? (
        <div className="mt-2">
          <RedactedMarker />
        </div>
      ) : null}
    </div>
  );
}
