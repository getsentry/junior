import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import { cn } from "../styles";
import { DetailsPanel } from "../components/DetailsPanel";
import type { ConversationTranscript } from "../types";
import { useEventTime } from "./eventTime";
import { EventDetails } from "./EventDetails";
import { ForkConversationButton } from "./ForkConversationButton";

/** Show the selected event without blocking the main conversation's event log. */
export function ConversationEventDetails(props: {
  conversation: ConversationTranscript;
  event: ConversationReportEvent;
  onClose(): void;
  overlay?: boolean;
}) {
  const { conversation, event } = props;
  const time = useEventTime();
  const title = (
    <>
      <h2 className="m-0 break-words font-mono text-sm font-semibold text-dashboard-text">
        {event.data.type}
      </h2>
      <time
        className="mt-1 block break-words font-mono text-xs text-dashboard-text-muted"
        dateTime={event.createdAt}
        title={event.createdAt}
      >
        {time.formatTimestamp(event.createdAt)}
      </time>
    </>
  );

  return (
    <DetailsPanel
      key={event.seq}
      label="Event details"
      onClose={props.onClose}
      overlay={props.overlay}
      title={title}
    >
      <div
        className={cn(
          "min-w-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
          props.overlay && "xl:p-0",
        )}
      >
        <div className="mb-5 xl:hidden">{title}</div>
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
      </div>
    </DetailsPanel>
  );
}
