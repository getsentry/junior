import { ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";
import type { ConversationTranscript } from "../types";
import {
  eventLogModel,
  eventLogSummary,
  eventLogTone,
  eventLogUsage,
} from "./eventLog";
import { ConversationEventDetails } from "./ConversationEventDetails";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

const rowClass =
  "grid grid-cols-[12ch_minmax(0,1fr)_1rem] items-baseline gap-x-3 px-4 @min-[32rem]:grid-cols-[12ch_17ch_minmax(0,1fr)_1rem]";

/**
 * Show every reporting event in sequence order, outside the transcript reducer.
 * Pass `onSelectedSeqChange` to own selection and render details beside the log.
 * Standalone transcripts keep a local selection and show an overlay.
 */
export const ConversationEventLog = memo(function ConversationEventLog(props: {
  conversation: ConversationTranscript;
  onSearchChange(value: string): void;
  onSelectedSeqChange?(seq: number | undefined): void;
  selectedSeq?: number;
}) {
  const { conversation } = props;
  const search = useTranscriptSearch();
  const [localSelectedSeq, setLocalSelectedSeq] = useState<number>();
  const selectedSeq = props.onSelectedSeqChange
    ? props.selectedSeq
    : localSelectedSeq;
  const setSelectedSeq = props.onSelectedSeqChange ?? setLocalSelectedSeq;
  const listRef = useRef<HTMLOListElement>(null);
  // Rows opened by a click are already visible. Scroll only for a linked entry.
  const revealedSeqRef = useRef<number>(undefined);
  const events = conversation.events;
  const rows = useMemo(
    () =>
      events.map((event) => {
        const model = eventLogModel(event);
        return {
          event,
          summary: eventLogSummary(event.data)
            .replace(/\s+/g, " ")
            .slice(0, 300),
          metadata: [
            model?.modelId,
            model?.modelProfile,
            model?.reasoningLevel && `${model.reasoningLevel} reasoning`,
            eventLogUsage(event),
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    [events],
  );
  // Large payloads are serialized only for an active search or the open entry.
  const visibleRows = useMemo(
    () =>
      search.active
        ? rows.filter(({ event, summary, metadata }) =>
            `${summary} ${metadata} ${JSON.stringify(event)}`
              .toLowerCase()
              .includes(search.normalizedQuery),
          )
        : rows,
    [rows, search.active, search.normalizedQuery],
  );
  // Resolve the selection from current data so polling cannot leave stale details.
  const selected = events.find((event) => event.seq === selectedSeq);
  useEffect(() => {
    if (selectedSeq === undefined || revealedSeqRef.current === selectedSeq) {
      return;
    }
    const row = listRef.current?.querySelector(
      `[data-event-seq="${selectedSeq}"]`,
    );
    if (!row) return;
    revealedSeqRef.current = selectedSeq;
    row.scrollIntoView({ block: "center" });
  }, [selectedSeq, visibleRows]);

  if (conversation.eventHistory.status === "expired") {
    return (
      <p className="text-sm text-dashboard-text-muted">
        Event history expired for this conversation.
      </p>
    );
  }

  return (
    <section aria-label="Conversation event log" className="@container min-w-0">
      <div className="sticky top-0 z-10 bg-dashboard-bg">
        <div className="flex flex-wrap items-center gap-2 border-b border-dashboard-border px-4 py-2">
          <SearchInput
            className="min-w-32 flex-1"
            label="Search events"
            onChange={props.onSearchChange}
            placeholder="Search events…"
            size="compact"
            value={search.query}
          />
          <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-xs text-dashboard-text-muted">
            <span role="status">
              {search.active
                ? `${visibleRows.length} of ${events.length} loaded events`
                : `${events.length} loaded events`}
            </span>
            <span title="Event times in UTC">UTC</span>
          </div>
        </div>
        <div
          aria-hidden="true"
          className={cn(
            rowClass,
            "border-b border-dashboard-border py-2 font-mono text-xs text-dashboard-text-muted",
          )}
        >
          <span>Time</span>
          <span>Event</span>
          <span className="hidden @min-[32rem]:block">Summary</span>
          <span />
        </div>
      </div>
      <div className="font-mono text-xs">
        <ol
          aria-label="Events"
          className="m-0 list-none divide-y divide-dashboard-border-subtle p-0"
          ref={listRef}
        >
          {visibleRows.map(({ event, summary, metadata }) => (
            <li data-event-seq={event.seq} key={event.seq}>
              <button
                aria-expanded={selectedSeq === event.seq}
                aria-label={`Event ${event.seq}: ${event.data.type}`}
                className={cn(
                  rowClass,
                  "min-h-11 w-full cursor-pointer border-0 bg-transparent py-2 text-left leading-5 hover:bg-dashboard-fill-hover active:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus @min-[32rem]:min-h-9 @min-[32rem]:py-1.5",
                  selectedSeq === event.seq && "bg-dashboard-fill-strong",
                )}
                onClick={() => {
                  revealedSeqRef.current = event.seq;
                  setSelectedSeq(event.seq);
                }}
                type="button"
              >
                <time
                  className="tabular-nums text-dashboard-text-muted"
                  dateTime={event.createdAt}
                  title={event.createdAt}
                >
                  {event.createdAt.slice(11, 23)}
                </time>
                <span
                  className={cn("truncate", eventLogTone(event.data))}
                  title={event.data.type}
                >
                  <HighlightText text={event.data.type} />
                </span>
                <span className="col-span-2 row-start-2 grid min-w-0 gap-0.5 text-dashboard-text @min-[32rem]:col-span-1 @min-[32rem]:row-auto">
                  <span className="truncate" title={summary}>
                    <HighlightText text={summary} />
                  </span>
                  {metadata ? (
                    <span
                      className="truncate text-dashboard-text-muted"
                      title={metadata}
                    >
                      <HighlightText text={metadata} />
                    </span>
                  ) : null}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="col-start-3 row-start-1 text-dashboard-text-muted @min-[32rem]:col-start-4"
                  size={14}
                />
              </button>
            </li>
          ))}
        </ol>
        {visibleRows.length === 0 ? (
          <p className="m-0 px-3 py-6 text-sm text-dashboard-text-muted">
            {search.active
              ? "No events match your search."
              : "No events available."}
          </p>
        ) : null}
      </div>
      {selected && !props.onSelectedSeqChange
        ? createPortal(
            <ConversationEventDetails
              overlay
              conversation={conversation}
              event={selected}
              onClose={() => setSelectedSeq(undefined)}
            />,
            document.body,
          )
        : null}
    </section>
  );
});
