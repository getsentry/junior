import { CircleAlert } from "lucide-react";
import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@sentry/junior/api/schema";

import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { formatMessageTimestamp } from "../format";
import {
  transcriptFailureDescription,
  transcriptFailureTitle,
} from "./transcriptFailure";

/** Render a terminal transcript failure as a distinct alert surface. */
export function TranscriptFailureView(props: {
  eventId?: string;
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  sentryEventUrl?: string;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const eventReference = props.eventId ? (
    props.sentryEventUrl ? (
      <a
        className="font-mono text-rose-100/80 underline decoration-rose-100/30 underline-offset-2 transition-colors hover:text-rose-50 hover:decoration-rose-100/70"
        href={props.sentryEventUrl}
        rel="noreferrer"
        target="_blank"
      >
        {`event_id=${props.eventId}`}
      </a>
    ) : (
      <span className="font-mono text-rose-100/80">{`event_id=${props.eventId}`}</span>
    )
  ) : null;

  return (
    <Alert
      className="min-w-0 gap-3 rounded-lg border-0 bg-rose-300/[0.1] px-4 py-3 text-rose-100 *:[svg]:row-span-1 has-[>svg]:grid-cols-[auto_minmax(0,1fr)_auto] has-[>svg]:gap-x-3 max-md:has-[>svg]:grid-cols-[auto_minmax(0,1fr)] *:[svg]:text-rose-300"
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
          <div className="mt-2 text-xs leading-relaxed text-rose-100/65">
            Reference: {eventReference}
          </div>
        ) : null}
      </div>
      {timestamp ? (
        <span className="font-mono text-xs leading-none text-rose-100/55 max-md:col-start-2">
          {timestamp}
        </span>
      ) : null}
    </Alert>
  );
}
