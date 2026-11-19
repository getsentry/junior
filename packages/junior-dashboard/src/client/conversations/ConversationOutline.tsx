import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  startTransition,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@dashboard/lib/utils";
import {
  conversationOutlineSchema,
  type ConversationReportEvent,
} from "@sentry/junior/api/schema";

import {
  MessageOutline,
  MessageOutlineItem,
  MessageOutlineList,
  MessageOutlinePreview,
  MessageOutlinePreviewDescription,
  MessageOutlinePreviewMeta,
  MessageOutlinePreviewTitle,
  useMessageOutline,
} from "../components/ui/message-outline";
import { fetchDashboardJson } from "../http";
import { transcriptMessageActorLabel } from "../format";
import { formatTranscriptMessageTime } from "../time";
import type { ConversationTranscript } from "../types";
import {
  conversationOutlineItems,
  mergeConversationOutlineItems,
  outlineItemAtSeq,
  type ConversationOutlineItem,
} from "./conversationOutlineItems";
import { transcriptMessagesFromEvents } from "./eventTranscript";
import { OutlineStandIn } from "./OutlineStandIn";
import {
  cachedStartPage,
  prefetchHistoryAround,
  unheldLinkStart,
  type HistoryStart,
} from "./transcriptAroundHistory";
import { useScrollsWithOutline } from "./transcriptScroller";

const NO_EVENTS: ConversationReportEvent[] = [];

/** Room above a selected message, so it does not touch the viewport edge. */
const JUMP_MARGIN_PX = 12;

/**
 * Show the person messages of a Conversation in an outline beside the
 * transcript. The item of the message being read is active, and a click puts
 * the message at the top of the transcript viewport. It shows two or more
 * messages only.
 *
 * The transcript loads only some pages, so the items come from the outline
 * of the whole Conversation and from the loaded rows. `onSelect` must make
 * the transcript load and mount the row of the seq, because the transcript
 * mounts only the rows near the viewport.
 *
 * When the person scrolls with the outline, it stands in for the scrollbar
 * while it shows: it marks the items on screen, a drag along it jumps, and
 * `ChatLayout` hides the scrollbar of the region.
 */
export function ConversationOutline(props: {
  /** Names the authors. Previews show no author before it loads. */
  conversation: ConversationTranscript | undefined;
  conversationId: string;
  events: ConversationReportEvent[];
  onSelect(seq: number): void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { scrollRef } = props;
  // The transcript paints first. The outline builds after it, without
  // blocking input.
  const events = useDeferredValue(props.events, NO_EVENTS);
  const outline = useConversationOutline(props.conversationId).data;
  // Items show text only, so they need no cards or annotations.
  const items = useMemo(
    () =>
      mergeConversationOutlineItems(
        outline,
        conversationOutlineItems(
          transcriptMessagesFromEvents(events, undefined),
        ),
      ),
    [events, outline],
  );
  const scrollsWithOutline = useScrollsWithOutline();
  const seqsInView = useOutlineSeqsInView(items, scrollRef, scrollsWithOutline);
  const navRef = useRef<HTMLElement>(null);
  const replacesScrollbar = useDisplayed(
    navRef,
    scrollsWithOutline && items.length >= 2,
  );
  const [jumpSeq, setJumpSeq] = useState<number>();
  // In place of the scrollbar, a jump shows its message at once: the item
  // stands in for its rows until they land, so no page read sits between
  // the input and the first frame.
  const [standInSeq, setStandInSeq] = useState<number>();
  const standInIndex =
    replacesScrollbar && props.conversation && standInSeq !== undefined
      ? items.findIndex((item) => item.seq === standInSeq)
      : -1;
  const standIn = items[standInIndex];
  const activeIndex =
    standInIndex >= 0
      ? standInIndex
      : items.findIndex((item) => item.seq === seqsInView.top);
  const lastIndex =
    standInIndex >= 0
      ? standInIndex
      : items.findIndex((item) => item.seq === seqsInView.bottom);
  const inView = useMemo(
    () =>
      replacesScrollbar && activeIndex >= 0
        ? { from: activeIndex, to: Math.max(activeIndex, lastIndex) }
        : undefined,
    [activeIndex, lastIndex, replacesScrollbar],
  );

  // The latest jump. A row that lands for an older jump does not move the
  // transcript.
  const jumpedSeqRef = useRef<number>(undefined);
  const jumpToMountedRow = (seq: number): boolean => {
    const scroll = scrollRef.current;
    const row = scroll?.querySelector(`[data-transcript-seq="${seq}"]`);
    if (!scroll || !row) return false;
    jumpedSeqRef.current = seq;
    alignRow(scroll, row);
    setJumpSeq(undefined);
    setStandInSeq(undefined);
    return true;
  };
  const select = (seq: number) => {
    if (!replacesScrollbar) {
      props.onSelect(seq);
      setJumpSeq(seq);
      return;
    }
    if (jumpToMountedRow(seq)) return;
    setStandInSeq(seq);
    // The transcript renders the rows after the stand-in paints.
    startTransition(() => {
      props.onSelect(seq);
      setJumpSeq(seq);
    });
  };
  // A drag moves the transcript to mounted rows and shows other items as
  // stand-ins, so no transcript render or page read waits in it. The
  // release goes to the last item.
  const scrubSeqRef = useRef<number>(undefined);
  const scrub = (seq: number) => {
    scrubSeqRef.current = seq;
    if (jumpToMountedRow(seq)) return;
    jumpedSeqRef.current = undefined;
    setJumpSeq(undefined);
    setStandInSeq(seq);
  };
  const endScrub = () => {
    const seq = scrubSeqRef.current;
    scrubSeqRef.current = undefined;
    if (seq !== undefined) select(seq);
  };

  // A message outside the loaded rows renders after its page loads, so the
  // jump waits for new events.
  useEffect(() => {
    if (jumpSeq === undefined) return;
    const scroll = scrollRef.current;
    const rowAt = () =>
      scroll?.querySelector(`[data-transcript-seq="${jumpSeq}"]`);
    if (!scroll || !rowAt()) return;
    setJumpSeq(undefined);
    jumpedSeqRef.current = jumpSeq;
    const align = () => {
      const row = rowAt();
      if (!row || jumpedSeqRef.current !== jumpSeq) return false;
      alignRow(scroll, row);
      return true;
    };
    align();
    // In the next frame, the rows of a page that rendered with the jump
    // measure, and the transcript moves back to the place it held. So the
    // jump aligns again after that frame, unless a newer jump started. Then
    // the rows hold still, and the stand-in goes.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!align()) return;
        setStandInSeq((seq) => (seq === jumpSeq ? undefined : seq));
      }),
    );
  }, [events, jumpSeq, scrollRef]);

  // A person who scrolls the transcript takes over from the stand-in.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || standInSeq === undefined) return;
    const hide = () => setStandInSeq(undefined);
    const inputs = ["keydown", "touchstart", "wheel"] as const;
    for (const input of inputs) {
      scroll.addEventListener(input, hide, { passive: true });
    }
    return () => {
      for (const input of inputs) scroll.removeEventListener(input, hide);
    };
  }, [scrollRef, standInSeq]);

  // The pages of the pointed item and its neighbours load before a click,
  // so the click finds them. One read runs at a time, and a newly pointed
  // item replaces the reads that have not started.
  const queryClient = useQueryClient();
  const prefetchRef = useRef<{ reading: boolean; seqs: number[] }>({
    reading: false,
    seqs: [],
  });
  const readNextPage = () => {
    const queue = prefetchRef.current;
    if (queue.reading) return;
    let start: HistoryStart | undefined;
    while (!start && queue.seqs.length) {
      start = unheldLinkStart(props.events, { event: queue.seqs.shift()! });
      if (start && cachedStartPage(queryClient, props.conversationId, start)) {
        start = undefined;
      }
    }
    if (!start) return;
    queue.reading = true;
    void prefetchHistoryAround(
      queryClient,
      props.conversationId,
      start,
    ).finally(() => {
      queue.reading = false;
      readNextPageRef.current();
    });
  };
  // A read that lands goes on with the events of the latest render.
  const readNextPageRef = useRef(readNextPage);
  useEffect(() => {
    readNextPageRef.current = readNextPage;
  });
  const prefetch = (index: number) => {
    prefetchRef.current.seqs = [index, index - 1, index + 1].flatMap(
      (near) => items[near]?.seq ?? [],
    );
    readNextPage();
  };

  if (items.length < 2) return null;
  // In place of the scrollbar, the rail sits where the scrollbar would.
  const side = scrollsWithOutline ? "right" : "left";
  return (
    <>
      {standIn && props.conversation ? (
        <OutlineStandIn
          conversation={props.conversation}
          item={standIn}
          topPx={JUMP_MARGIN_PX}
        />
      ) : null}
      <MessageOutline
        // `ChatLayout` hides the scrollbar beside this attribute.
        data-replaces-scrollbar={replacesScrollbar ? "" : undefined}
        activeIndex={activeIndex}
        aria-label="Conversation outline"
        // From `md`, the transcript has side padding that holds the rail, so
        // it shows beside narrow transcripts too.
        className={cn(
          "absolute inset-y-8 z-20 hidden md:flex",
          side === "left"
            ? "left-1 @min-[62rem]/chat:left-3"
            : "right-1 @min-[62rem]/chat:right-3",
        )}
        itemCount={items.length}
        inView={inView}
        onScrub={
          replacesScrollbar
            ? (index) => {
                const item = items[index];
                if (item) scrub(item.seq);
              }
            : undefined
        }
        // A release bubbles up from the list.
        onPointerUp={endScrub}
        ref={navRef}
        side={side}
      >
        {/* The list's inner padding would cover text in a narrow transcript. */}
        <MessageOutlineList
          className={
            side === "left"
              ? "@max-[62rem]/chat:pr-0"
              : "@max-[62rem]/chat:pl-0"
          }
        >
          {items.map((item, index) => (
            <MessageOutlineItem
              aria-label={item.title}
              index={index}
              key={item.seq}
              onClick={() => select(item.seq)}
            />
          ))}
        </MessageOutlineList>
        <ConversationOutlinePreview
          conversation={props.conversation}
          items={items}
          prefetch={prefetch}
        />
      </MessageOutline>
    </>
  );
}

/**
 * Read the outline of the whole Conversation once per mount. It does not
 * poll: messages that arrive later come with the transcript.
 */
function useConversationOutline(conversationId: string) {
  return useQuery({
    // A new visit reads the outline again, so a cached copy cannot miss
    // messages that arrived while the reader was away.
    gcTime: 0,
    queryFn: ({ signal }) =>
      fetchDashboardJson(
        conversationOutlineSchema,
        `/api/conversations/${encodeURIComponent(conversationId)}/outline`,
        signal,
      ),
    queryKey: ["conversation", conversationId, "outline"],
    retry: false,
    staleTime: Infinity,
  });
}

/**
 * Preview the pointed message, who sent it and when, and Junior's reply.
 * The author has the same name as on the message's transcript row.
 */
function ConversationOutlinePreview(props: {
  conversation: ConversationTranscript | undefined;
  items: readonly ConversationOutlineItem[];
  prefetch(index: number): void;
}) {
  const { previewIndex } = useMessageOutline();
  const item =
    previewIndex === undefined ? undefined : props.items[previewIndex];
  const prefetch = useEffectEvent(props.prefetch);
  useEffect(() => {
    if (previewIndex !== undefined) prefetch(previewIndex);
  }, [previewIndex]);
  if (!item) return null;
  const meta = [
    props.conversation &&
      transcriptMessageActorLabel(props.conversation, {
        ...item.author,
        parts: [],
        role: "user",
        sourceSeq: item.seq,
      }),
    item.timestamp === undefined
      ? undefined
      : formatTranscriptMessageTime(item.timestamp),
  ].filter(Boolean);
  return (
    <MessageOutlinePreview>
      {meta.length > 0 ? (
        <MessageOutlinePreviewMeta>
          {meta.join(" · ")}
        </MessageOutlinePreviewMeta>
      ) : null}
      <MessageOutlinePreviewTitle>{item.title}</MessageOutlinePreviewTitle>
      {item.reply ? (
        <MessageOutlinePreviewDescription>
          {item.reply}
        </MessageOutlinePreviewDescription>
      ) : null}
    </MessageOutlinePreview>
  );
}

/**
 * Track the item whose section holds the top of the transcript viewport,
 * and with `withBottom` the one that holds the bottom. The transcript mounts
 * only rows near the viewport, so this reads the seqs of the mounted rows,
 * not the item rows themselves.
 */
function useOutlineSeqsInView(
  items: readonly ConversationOutlineItem[],
  scrollRef: RefObject<HTMLDivElement | null>,
  withBottom: boolean,
): { bottom: number | undefined; top: number | undefined } {
  const [top, setTop] = useState<number>();
  const [bottom, setBottom] = useState<number>();
  const update = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const viewport = scroll.getBoundingClientRect();
    const viewTop = viewport.top + JUMP_MARGIN_PX;
    let topRowSeq: number | undefined;
    let topRowStart = Infinity;
    let bottomRowSeq: number | undefined;
    let bottomRowStart = -Infinity;
    for (const row of scroll.querySelectorAll<HTMLElement>(
      "[data-transcript-seq]",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= viewTop) continue;
      const seq = Number(row.dataset["transcriptSeq"]);
      if (rect.top < topRowStart) {
        topRowStart = rect.top;
        topRowSeq = seq;
      }
      if (rect.top < viewport.bottom && rect.top > bottomRowStart) {
        bottomRowStart = rect.top;
        bottomRowSeq = seq;
      }
    }
    const itemSeq = (seq: number | undefined) =>
      seq === undefined ? undefined : outlineItemAtSeq(items, seq)?.seq;
    setTop(itemSeq(topRowSeq));
    // The bottom item changes the outline only when it marks a thumb, so
    // the default outline does not render on its change.
    setBottom(withBottom ? itemSeq(bottomRowSeq) : undefined);
  }, [items, scrollRef, withBottom]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    schedule();
    scroll.addEventListener("scroll", schedule, { passive: true });
    // A resize moves rows in and out of view without a scroll.
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, update]);

  return { bottom, top };
}

/**
 * Tell whether an element shows. The outline hides itself with CSS where
 * the transcript is narrow, so this reads the rendered box.
 */
function useDisplayed(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [displayed, setDisplayed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    // A change to or from `display: none` resizes the box.
    const observer = new ResizeObserver(() =>
      setDisplayed(element.getClientRects().length > 0),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setDisplayed(false);
    };
  }, [enabled, ref]);
  return enabled && displayed;
}

/** Put a row at the top of the transcript viewport, below a small margin. */
function alignRow(scroll: HTMLElement, row: Element) {
  scroll.scrollTop +=
    row.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top -
    JUMP_MARGIN_PX;
}
