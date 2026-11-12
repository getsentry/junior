import { CircleAlert } from "lucide-react";
import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@sentry/junior/api/schema";

import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  transcriptFailureDescription,
  transcriptFailureTitle,
} from "./transcriptFailure";
import { OutboundLink } from "../components/OutboundLink";
import { TranscriptTimestamp } from "./TranscriptTimestamp";

/** Render a terminal transcript failure as a distinct alert surface. */
export function TranscriptFailureView(props: {
  eventId?: string;
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  sentryEventUrl?: string;
  timestamp?: number;
}) {
  const eventLabel = props.eventId ? `event_id=${props.eventId}` : undefined;
  // A narrow screen truncates the id, so the outbound icon stays on its line.
  const eventReference = eventLabel ? (
    props.sentryEventUrl ? (
      <OutboundLink
        className="flex min-w-0 items-baseline font-mono text-rose-100/80 underline decoration-rose-100/30 underline-offset-2 transition-colors hover:text-rose-50 hover:decoration-rose-100/70"
        href={props.sentryEventUrl}
        title={eventLabel}
      >
        <span className="truncate">{eventLabel}</span>
      </OutboundLink>
    ) : (
      <span className="truncate font-mono text-rose-100/80" title={eventLabel}>
        {eventLabel}
      </span>
    )
  ) : null;

  return (
    <Alert
      className="min-w-0 gap-3 rounded-lg border-0 bg-rose-300/[0.1] px-4 py-3 *:[svg]:row-span-1 has-[>svg]:grid-cols-[auto_minmax(0,1fr)_auto] has-[>svg]:gap-x-3 max-md:has-[>svg]:grid-cols-[auto_minmax(0,1fr)]"
      data-transcript-failure={props.failureCode}
      data-transcript-failure-event-id={props.eventId}
      data-transcript-failure-reason={props.failureReason}
      variant="destructive"
    >
      <CircleAlert aria-hidden="true" size={16} />
      <div className="min-w-0">
        <AlertTitle className="font-display text-base font-semibold leading-tight">
          {transcriptFailureTitle(props.failureCode, props.failureReason)}
        </AlertTitle>
        <AlertDescription className="mt-1 leading-relaxed text-rose-100/70">
          {transcriptFailureDescription(props.failureCode, props.failureReason)}
        </AlertDescription>
        {eventReference ? (
          <div className="mt-2 flex min-w-0 items-baseline gap-1 text-xs leading-relaxed text-rose-100/65">
            <span className="shrink-0">Reference:</span>
            {eventReference}
          </div>
        ) : null}
      </div>
      {props.timestamp === undefined ? null : (
        <span className="text-xs leading-5 text-rose-100/55 max-md:col-start-2">
          <TranscriptTimestamp value={props.timestamp} />
        </span>
      )}
    </Alert>
  );
}
