import { CircleAlert } from "lucide-react";
import type {
  ConversationTurnFailureCode,
  ConversationTurnFailureReason,
} from "@sentry/junior/api/schema";

import { formatMessageTimestamp } from "../format";
import {
  transcriptFailureDescription,
  transcriptFailureTitle,
} from "./transcriptFailure";

/** Render a terminal transcript failure as a distinct alert surface. */
export function TranscriptFailureView(props: {
  failureCode: ConversationTurnFailureCode;
  failureReason?: ConversationTurnFailureReason;
  timestamp?: number;
}) {
  const timestamp = formatMessageTimestamp(props.timestamp);
  const detail = props.failureReason ?? props.failureCode;

  return (
    <div
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-lg bg-rose-300/[0.1] px-4 py-3 text-rose-100 max-md:grid-cols-[auto_minmax(0,1fr)]"
      data-transcript-failure={props.failureCode}
      data-transcript-failure-reason={props.failureReason}
      role="alert"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 text-rose-300"
        size={16}
      />
      <div className="min-w-0">
        <div className="font-display text-base font-semibold leading-tight">
          {transcriptFailureTitle(props.failureCode, props.failureReason)}
        </div>
        <div className="mt-1 text-sm leading-relaxed text-rose-100/70">
          {transcriptFailureDescription(props.failureCode, props.failureReason)}
        </div>
        <div className="mt-1 font-mono text-xs leading-none text-rose-100/55">
          {detail}
        </div>
      </div>
      {timestamp ? (
        <span className="font-mono text-xs leading-none text-rose-100/55 max-md:col-start-2">
          {timestamp}
        </span>
      ) : null}
    </div>
  );
}
