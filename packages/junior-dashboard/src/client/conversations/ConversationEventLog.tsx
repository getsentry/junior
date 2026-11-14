import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Skeleton } from "../components/ui/skeleton";
import { Toggle } from "../components/ui/toggle";
import { useEventTime } from "./eventTime";
import { SearchInput } from "../components/SearchInput";
import { cn } from "../styles";
import type { ConversationTranscript } from "../types";
import {
  adjacentEventLogSeqs,
  eventLogRows,
  eventLogTone,
  filterEventLogRows,
} from "./eventLog";
import { ConversationEventDetails } from "./ConversationEventDetails";
import { HighlightText, useTranscriptSearch } from "./transcriptSearch";
import { useVirtualRows } from "./virtualRows";

const rowClass =
  "grid grid-cols-[12ch_minmax(0,1fr)] items-baseline gap-x-3 px-4 @min-[32rem]:grid-cols-[12ch_17ch_minmax(0,1fr)]";

/**
 * Show every reporting event in sequence order, outside the transcript reducer.
 * Pass `onSelectedSeqChange` to own selection and render details beside the log.
 * Standalone transcripts keep a local selection and show an overlay.
 */
export const ConversationEventLog = memo(function ConversationEventLog(props: {
  conversation: ConversationTranscript;
  onSearchChange(value: string): void;
  onSelectedSeqChange?(seq: number | undefined): void;
  /** The row that holds the reader's place, from the scroll owner. */
  scrollAnchorKey?: () => string | undefined;
  selectedSeq?: number | undefined;
}) {
  const { conversation } = props;
  const time = useEventTime();
  const search = useTranscriptSearch();
  const [localSelectedSeq, setLocalSelectedSeq] = useState<number>();
  const selectedSeq = props.onSelectedSeqChange
    ? props.selectedSeq
    : localSelectedSeq;
  const setSelectedSeq = props.onSelectedSeqChange ?? setLocalSelectedSeq;
  const listRef = useRef<HTMLOListElement>(null);
  // Clicked rows are visible. Reveal links and keyboard selections after layout.
  const revealedSeqRef = useRef<number>(undefined);
  const events = conversation.events;
  const rows = useMemo(() => eventLogRows(events), [events]);
  // Large payloads are serialized only for an active search or the open entry.
  const visibleRows = useMemo(
    () => filterEventLogRows(rows, search.normalizedQuery),
    [rows, search.normalizedQuery],
  );
  // Resolve the selection from current data so polling cannot leave stale details.
  const selected = events.find((event) => event.seq === selectedSeq);
  // An arrow key can select a row that mounts only on the next render.
  const focusSeqRef = useRef<number>(undefined);
  const focusedSeqRef = useRef<number>(undefined);
  const indexBySeq = useMemo(
    () => new Map(visibleRows.map((row, index) => [row.event.seq, index])),
    [visibleRows],
  );
  const indexOf = (seq: number | undefined) =>
    seq === undefined ? undefined : indexBySeq.get(seq);
  // The open entry, the focused row, and the row that holds the reader's
  // place stay mounted.
  const virtualizer = useVirtualRows({
    count: visibleRows.length,
    defaultSize: (sizeClass) => (sizeClass === "metadata" ? 56 : 40),
    getItemKey: (index) => visibleRows[index]?.event.seq ?? index,
    keptIndexes: [
      indexOf(selectedSeq),
      indexOf(focusedSeqRef.current),
      indexOf(anchorSeq(props.scrollAnchorKey?.())),
    ],
    listRef,
    sizeClass: (index) => (visibleRows[index]?.metadata ? "metadata" : "plain"),
  });
  const virtualRows = virtualizer.getVirtualItems();
  useEffect(() => {
    if (selectedSeq === undefined) return;
    const row = listRef.current?.querySelector(
      `[data-event-seq="${selectedSeq}"]`,
    );
    if (!row) return;
    if (focusSeqRef.current === selectedSeq) {
      focusSeqRef.current = undefined;
      row
        .querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    }
    if (revealedSeqRef.current === selectedSeq) return;
    revealedSeqRef.current = selectedSeq;
    row.scrollIntoView({ block: "nearest" });
  }, [selectedSeq, virtualRows]);

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
            className="min-w-32 flex-1 @max-[28rem]:basis-full"
            label="Search events"
            onChange={props.onSearchChange}
            placeholder="Search events…"
            size="compact"
            value={search.query}
          />
          <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-xs text-dashboard-text-muted @max-[28rem]:w-full @max-[28rem]:justify-between">
            <span role="status">
              {search.active
                ? `${visibleRows.length} of ${events.length} loaded events`
                : `${events.length} loaded events`}
            </span>
            <Toggle
              aria-label="Use local time"
              onPressedChange={time.toggle}
              pressed={time.local}
              title={time.title}
            >
              <span className="max-w-32 truncate">{time.label}</span>
            </Toggle>
          </div>
        </div>
        <EventLogColumns />
      </div>
      <div className="font-mono text-xs">
        {/* Only rows near the viewport mount. Each row is placed at its
            measured offset, so the list keeps its full height. */}
        <ol
          aria-label="Events"
          className="relative m-0 list-none p-0"
          ref={listRef}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualRows.map((virtualRow) => {
            const { event, summary, metadata } = visibleRows[virtualRow.index]!;
            const index = virtualRow.index;
            return (
              <li
                className={cn(
                  "absolute left-0 top-0 w-full scroll-mt-32 scroll-mb-2",
                  index > 0 && "border-t border-dashboard-border-subtle",
                )}
                data-event-seq={event.seq}
                data-index={index}
                data-scroll-anchor={`event:${event.seq}`}
                key={virtualRow.key}
                onBlur={() => {
                  if (focusedSeqRef.current === event.seq) {
                    focusedSeqRef.current = undefined;
                  }
                }}
                onFocus={() => {
                  focusedSeqRef.current = event.seq;
                }}
                ref={virtualizer.measureElement}
                style={{
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                <button
                  aria-expanded={selectedSeq === event.seq}
                  aria-label={`Event ${event.seq}: ${event.data.type}`}
                  className={cn(
                    rowClass,
                    "relative min-h-11 w-full cursor-pointer border-0 bg-transparent py-2 text-left leading-5 hover:bg-dashboard-fill-hover active:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus @min-[32rem]:min-h-9 @min-[32rem]:py-1.5",
                    selectedSeq === event.seq &&
                      "bg-dashboard-fill-strong before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-dashboard-accent before:content-['']",
                  )}
                  onClick={() => {
                    revealedSeqRef.current = event.seq;
                    setSelectedSeq(event.seq);
                  }}
                  onKeyDown={(keyEvent) => {
                    if (
                      keyEvent.altKey ||
                      keyEvent.ctrlKey ||
                      keyEvent.metaKey ||
                      keyEvent.shiftKey ||
                      (keyEvent.key !== "ArrowUp" &&
                        keyEvent.key !== "ArrowDown")
                    )
                      return;
                    keyEvent.preventDefault();
                    const next =
                      visibleRows[
                        index + (keyEvent.key === "ArrowDown" ? 1 : -1)
                      ];
                    if (!next) return;
                    setSelectedSeq(next.event.seq);
                    // Focus a mounted row now, so the next key press reaches
                    // it. A row past the mounted range gets focus after it
                    // mounts.
                    const nextButton =
                      listRef.current?.querySelector<HTMLButtonElement>(
                        `[data-event-seq="${next.event.seq}"] button`,
                      );
                    if (nextButton) nextButton.focus({ preventScroll: true });
                    else focusSeqRef.current = next.event.seq;
                  }}
                  type="button"
                >
                  <time
                    className="tabular-nums text-dashboard-text-muted"
                    dateTime={event.createdAt}
                    title={time.formatTimestamp(event.createdAt)}
                  >
                    {time.formatClock(event.createdAt)}
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
                </button>
              </li>
            );
          })}
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
              onSelect={setSelectedSeq}
              {...adjacentEventLogSeqs(visibleRows, selected.seq)}
            />,
            document.body,
          )
        : null}
    </section>
  );
});

/** Read the event seq from a `data-scroll-anchor` key. */
function anchorSeq(key: string | undefined): number | undefined {
  return key?.startsWith("event:") ? Number(key.slice(6)) : undefined;
}

const loadingRowWidths = ["w-3/5", "w-2/5", "w-4/5", "w-1/2", "w-2/3", "w-1/3"];

/** Match the event log toolbar, columns, and rows while the transcript loads. */
export function ConversationEventLogLoading() {
  return (
    <section aria-busy="true" className="@container min-w-0">
      <span className="sr-only" role="status">
        Loading events
      </span>
      <div className="sticky top-0 z-10 bg-dashboard-bg">
        <div className="flex flex-wrap items-center gap-2 border-b border-dashboard-border px-4 py-2">
          <Skeleton className="h-9 min-w-32 flex-1 @max-[28rem]:basis-full" />
          <Skeleton className="ml-auto h-3 w-24" />
        </div>
        <EventLogColumns />
      </div>
      <ol className="m-0 list-none divide-y divide-dashboard-border-subtle p-0">
        {loadingRowWidths.map((width, index) => (
          <li
            className={cn(
              rowClass,
              "min-h-11 items-center gap-y-2 py-2 @min-[32rem]:min-h-9 @min-[32rem]:py-1.5",
            )}
            key={index}
          >
            <Skeleton className="h-3 w-[10ch]" />
            <Skeleton className="h-3 w-[12ch]" />
            <Skeleton
              className={cn(
                "col-span-2 row-start-2 h-3 @min-[32rem]:col-span-1 @min-[32rem]:row-auto",
                width,
              )}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function EventLogColumns() {
  return (
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
    </div>
  );
}
