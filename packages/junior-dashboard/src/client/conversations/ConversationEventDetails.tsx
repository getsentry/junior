import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "../styles";
import { DetailsPanel } from "../components/DetailsPanel";
import { Button } from "../components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "../components/ui/button-group";
import { Skeleton } from "../components/ui/skeleton";
import type { ConversationTranscript } from "../types";
import { useEventTime } from "./eventTime";
import { EventDetails } from "./EventDetails";
import { ForkConversationButton } from "./ForkConversationButton";

// Step buttons keep focus at the ends of the log, so style the ARIA state.
// They sit in one bordered group, so they are a little smaller than `size-9`.
const stepButtonClass =
  "size-8 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-disabled:hover:!bg-transparent data-disabled:hover:!text-dashboard-text-muted";

/**
 * Show the selected event without blocking the main conversation's event log.
 * Without an event, show a loading state while a linked event loads.
 * `previous` and `next` are the adjacent visible rows of the event log.
 */
export function ConversationEventDetails(props: {
  conversation?: ConversationTranscript;
  event?: ConversationReportEvent;
  next?: number;
  onClose(): void;
  onSelect?(seq: number): void;
  overlay?: boolean;
  previous?: number;
}) {
  const { conversation, event, onSelect } = props;
  const time = useEventTime();
  // The sequence number matches the `event` link parameter and the row label.
  // The line stays on one row beside the actions. The tooltip keeps the
  // milliseconds that the short timestamp leaves out.
  const timestamp = event ? (
    <p className="m-0 flex min-w-0 gap-x-1.5 whitespace-nowrap font-sans text-xs tabular-nums text-dashboard-text-muted">
      <span className="shrink-0">#{event.seq}</span>
      <span aria-hidden="true">·</span>
      <time
        className="min-w-0 truncate"
        dateTime={event.createdAt}
        title={time.formatTimestamp(event.createdAt)}
      >
        {time.formatShortTimestamp(event.createdAt)}
      </time>
    </p>
  ) : null;
  const title = event ? (
    <>
      <h2 className="m-0 mb-1 break-words font-mono text-sm font-semibold text-dashboard-text">
        {event.data.type}
      </h2>
      {timestamp}
    </>
  ) : (
    <div className="grid gap-2 py-0.5">
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="h-3 w-40" />
    </div>
  );
  const actions =
    onSelect && event ? (
      <ButtonGroup
        aria-label="Event navigation"
        className="rounded-md border border-dashboard-border"
      >
        <Button
          aria-label="Previous event"
          className={stepButtonClass}
          disabled={props.previous === undefined}
          focusableWhenDisabled
          onClick={() => {
            if (props.previous !== undefined) onSelect(props.previous);
          }}
          size="icon"
          title="Previous event"
        >
          <ChevronUp aria-hidden="true" size={15} />
        </Button>
        <ButtonGroupSeparator />
        <Button
          aria-label="Next event"
          className={stepButtonClass}
          disabled={props.next === undefined}
          focusableWhenDisabled
          onClick={() => {
            if (props.next !== undefined) onSelect(props.next);
          }}
          size="icon"
          title="Next event"
        >
          <ChevronDown aria-hidden="true" size={15} />
        </Button>
      </ButtonGroup>
    ) : undefined;

  return (
    <DetailsPanel
      actions={actions}
      label="Event details"
      onClose={props.onClose}
      overlay={props.overlay}
      sheetTitle={event?.data.type}
      title={title}
    >
      {/* Own the scroll here, so a new event starts at the top with closed
          disclosures, and the sheet actions stay below the content. */}
      <div
        className={cn(
          "h-full min-w-0 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
          props.overlay && "xl:p-0",
        )}
        key={event?.seq ?? "loading"}
      >
        {event && conversation ? (
          <>
            <div className="mb-4 xl:hidden">{timestamp}</div>
            {conversation.canFork &&
            event.data.type === "message" &&
            event.data.role === "assistant" &&
            !event.data.redacted ? (
              <div className="mb-3 flex items-center gap-2 text-sm">
                <ForkConversationButton
                  conversationId={conversation.conversationId}
                  messageId={event.data.messageId}
                />
                <span>Fork after this reply</span>
              </div>
            ) : null}
            <EventDetails event={event} />
          </>
        ) : (
          <EventDetailsLoading />
        )}
      </div>
    </DetailsPanel>
  );
}

/**
 * Keep the body quiet while the event loads. The header placeholders carry the
 * state, so the panel does not compete with the log skeleton.
 */
function EventDetailsLoading() {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">Loading event</span>
      <Skeleton className="h-3 w-40 xl:hidden" />
    </div>
  );
}
