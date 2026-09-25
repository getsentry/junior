import { ChevronRight } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Drawer } from "../components/Drawer";
import { cn } from "../styles";
import type { ConversationTranscript } from "../types";
import { eventLogSummary, eventLogTone } from "./eventLog";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";

const rowClass =
  "grid grid-cols-[4ch_12ch_minmax(0,1fr)_1rem] items-center gap-x-3 px-3 @min-[48rem]:grid-cols-[5ch_12ch_25ch_minmax(0,1fr)_1rem]";

/** Show every reporting event in sequence order, outside the transcript reducer. */
export const ConversationEventLog = memo(function ConversationEventLog(props: {
  conversation: ConversationTranscript;
}) {
  const { conversation } = props;
  const search = useTranscriptSearch();
  const [selectedSeq, setSelectedSeq] = useState<number>();
  const titleId = useId();
  const events = conversation.events;
  const rows = useMemo(
    () =>
      events.map((event) => ({
        event,
        summary: eventLogSummary(event.data).replace(/\s+/g, " ").slice(0, 300),
      })),
    [events],
  );
  // Large payloads are serialized only for an active search or the open entry.
  const visibleRows = useMemo(
    () =>
      search.active
        ? rows.filter(({ event, summary }) =>
            `${summary} ${JSON.stringify(event)}`
              .toLowerCase()
              .includes(search.normalizedQuery),
          )
        : rows,
    [rows, search.active, search.normalizedQuery],
  );
  // Resolve the selection from current data so polling cannot leave stale details.
  const selected = events.find((event) => event.seq === selectedSeq);

  if (conversation.eventHistory.status === "expired") {
    return (
      <p className="text-sm text-dashboard-text-muted">
        Event history expired for this conversation.
      </p>
    );
  }

  return (
    <section aria-label="Conversation event log" className="@container min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-dashboard-text-muted">
        <span role="status">
          {search.active
            ? `${visibleRows.length} of ${events.length} loaded events`
            : `${events.length} loaded events`}
        </span>
        <span>Sequence order · Times in UTC · Select a row for details</span>
      </div>
      <div className="overflow-hidden rounded-md border border-dashboard-border bg-dashboard-surface-panel font-mono text-xs">
        <div
          aria-hidden="true"
          className={cn(
            rowClass,
            "border-b border-dashboard-border bg-dashboard-surface-raised py-2 text-dashboard-text-muted",
          )}
        >
          <span className="text-right">Seq</span>
          <span>Time (UTC)</span>
          <span>Event</span>
          <span className="hidden @min-[48rem]:block">Summary</span>
          <span />
        </div>
        <ol
          aria-label="Events"
          className="m-0 list-none divide-y divide-dashboard-border-subtle p-0"
        >
          {visibleRows.map(({ event, summary }) => (
            <li key={event.seq}>
              <button
                aria-haspopup="dialog"
                aria-label={`Event ${event.seq}: ${event.data.type}`}
                className={cn(
                  rowClass,
                  "min-h-11 w-full cursor-pointer border-0 bg-transparent py-2 text-left leading-5 hover:bg-dashboard-fill-hover active:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus @min-[48rem]:min-h-8 @min-[48rem]:py-1",
                  selectedSeq === event.seq && "bg-dashboard-fill-strong",
                )}
                onClick={() => setSelectedSeq(event.seq)}
                type="button"
              >
                <span className="text-right tabular-nums text-dashboard-text-muted">
                  {event.seq}
                </span>
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
                <span
                  className="col-span-3 row-start-2 truncate text-dashboard-text @min-[48rem]:col-span-1 @min-[48rem]:row-auto"
                  title={summary}
                >
                  <HighlightText text={summary} />
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="col-start-4 row-start-1 text-dashboard-text-muted @min-[48rem]:col-start-5"
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
      {selected
        ? createPortal(
            <Drawer
              closeLabel="Close event details"
              dismissLabel="Dismiss event details"
              header={
                <>
                  <h2
                    className="m-0 break-words font-mono text-sm font-semibold text-dashboard-text"
                    id={titleId}
                  >
                    {selected.data.type}
                  </h2>
                  <p className="mb-0 mt-1 font-mono text-xs text-dashboard-text-muted">
                    Event {selected.seq} · {selected.createdAt}
                  </p>
                </>
              }
              onClose={() => setSelectedSeq(undefined)}
              openKey={`${conversation.conversationId}:${selected.seq}`}
              titleId={titleId}
              width="wide"
            >
              <p className="mt-0 break-words text-sm leading-relaxed text-dashboard-text-subtle">
                {rows.find(({ event }) => event.seq === selectedSeq)?.summary}
              </p>
              <h3 className="mb-2 text-sm font-medium text-dashboard-text">
                Event data
              </h3>
              <pre
                className="m-0 whitespace-pre-wrap break-words rounded-md border border-dashboard-border bg-dashboard-surface-panel p-3 font-mono text-xs leading-relaxed text-dashboard-text"
                tabIndex={0}
              >
                {JSON.stringify(selected, null, 2)}
              </pre>
            </Drawer>,
            document.body,
          )
        : null}
    </section>
  );
});
