import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent } from "../components/ui/collapsible";
import { cn, dashboardDisclosureChevronClass } from "../styles";
import { DisplayText } from "../display-text/DisplayText";
import { ReviewItemChangeRow } from "../review-desk/ReviewItemChangeRow";
import { messageRawText } from "./transcriptRenderModel";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { RedactedMarker } from "./TranscriptRedacted";
import type { TranscriptViewMessage } from "../types";
import { useTranscriptRowOpen } from "./TranscriptRows";
import { TranscriptSummaryTrigger } from "./TranscriptSummary";
import { SourceMark } from "./SourceMark";
import { eventMessageSource } from "./transcriptSource";

function EventTypeChip(props: { eventType: string }) {
  return (
    <span className="break-all rounded-md border border-dashboard-border px-1.5 py-0.5 font-mono text-2xs leading-none text-dashboard-text-muted">
      <HighlightText text={props.eventType} />
    </span>
  );
}

/** Heading for several Events that arrived in one message. */
function batchSummary(events: readonly { label?: string }[]): string {
  // Name the resource only when every Event is about it.
  const label = events[0]?.label;
  const shared = label && events.every((event) => event.label === label);
  return `${events.length} events${shared ? ` · ${label}` : ""}`;
}

/** Render an Event Message whose heading expands its full text. */
export function TranscriptEventView(props: {
  message: TranscriptViewMessage;
  /** Keeps the text open while the row unmounts outside the viewport. */
  openKey?: string;
}) {
  const { active: searchActive } = useTranscriptSearch();
  const [open, setOpen] = useTranscriptRowOpen(props.openKey);
  const text = messageRawText(props.message);
  const redacted = props.message.parts.some(
    (part) => part.type === "text" && part.redacted,
  );
  const events = props.message.events ?? [];
  const mentions = props.message.mentions ?? [];
  const isBatch = events.length > 1;
  const source = eventMessageSource(props.message);
  const summary = isBatch
    ? batchSummary(events)
    : (props.message.trustedSummary ?? props.message.eventType ?? "");
  // With text, the heading sits in the disclosure button, which cannot hold
  // links.
  const links = !text;
  const heading = (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words font-display text-sm font-semibold leading-6 text-dashboard-text">
          <DisplayText
            inline
            links={links}
            mentions={mentions}
            text={summary}
          />
        </span>
        {source ? <SourceMark provider={source} /> : null}
        {!isBatch && props.message.eventType ? (
          <EventTypeChip eventType={props.message.eventType} />
        ) : null}
      </span>
      {isBatch ? (
        <span className="flex min-w-0 flex-col gap-1" role="list">
          {events.map((event, index) => (
            <span
              key={index}
              role="listitem"
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-dashboard-text-muted"
            >
              <span className="min-w-0 break-words">
                <DisplayText
                  inline
                  links={links}
                  mentions={mentions}
                  text={event.trustedSummary ?? event.eventType}
                />
              </span>
              <EventTypeChip eventType={event.eventType} />
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );

  const view = (
    <>
      {text ? (
        <Collapsible
          className="min-w-0"
          // Search holds the text open, so the heading button is off until
          // search ends.
          disabled={searchActive}
          onOpenChange={setOpen}
          open={searchActive || open}
        >
          <TranscriptSummaryTrigger
            flush
            className="group flex items-start gap-2 text-dashboard-text-muted"
          >
            {heading}
            <ChevronRight
              aria-hidden="true"
              className={cn(dashboardDisclosureChevronClass, "mt-1.5")}
              strokeWidth={2.2}
            />
          </TranscriptSummaryTrigger>
          <CollapsibleContent hiddenUntilFound>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dashboard-border bg-dashboard-surface-panel px-3 py-2 font-sans text-xs leading-relaxed text-dashboard-text-muted">
              <HighlightText text={text} />
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <>
          {heading}
          {redacted ? (
            <div className="mt-2">
              <RedactedMarker />
            </div>
          ) : null}
        </>
      )}
    </>
  );

  // A relay of a person change shows as its change row, like the person's
  // own message, not as an Event line. A message with changes lists its own
  // Events in `events`, so with none it only records changes.
  const changes = props.message.reviewItemChanges ?? [];
  const onlyChanges = changes.length > 0 && events.length === 0;
  return (
    <div className="min-w-0 py-1">
      {onlyChanges ? null : view}
      {changes.length ? (
        <div className={cn("grid min-w-0 gap-2", !onlyChanges && "mt-2")}>
          {changes.map((record, index) => (
            <ReviewItemChangeRow
              fallback={onlyChanges && changes.length === 1 ? view : null}
              key={index}
              record={record}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
