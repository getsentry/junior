import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
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
  const activeIndex = items.findIndex((item) => item.seq === seqsInView.top);
  const [jumpSeq, setJumpSeq] = useState<number>();
  const select = (seq: number) => {
    props.onSelect(seq);
    setJumpSeq(seq);
  };
  const navRef = useRef<HTMLElement>(null);
  const replacesScrollbar = useDisplayed(
    navRef,
    scrollsWithOutline && items.length >= 2,
  );
  const lastIndex = items.findIndex((item) => item.seq === seqsInView.bottom);
  const inView = useMemo(
    () =>
      replacesScrollbar && activeIndex >= 0
        ? { from: activeIndex, to: Math.max(activeIndex, lastIndex) }
        : undefined,
    [activeIndex, lastIndex, replacesScrollbar],
  );

  // A message outside the loaded rows renders after its page loads, so the
  // jump waits for new events.
  useEffect(() => {
    if (jumpSeq === undefined) return;
    const scroll = scrollRef.current;
    const row = scroll?.querySelector(`[data-transcript-seq="${jumpSeq}"]`);
    if (!scroll || !row) return;
    setJumpSeq(undefined);
    scroll.scrollTop +=
      row.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      JUMP_MARGIN_PX;
  }, [events, jumpSeq, scrollRef]);

  if (items.length < 2) return null;
  return (
    <MessageOutline
      // `ChatLayout` hides the scrollbar beside this attribute.
      data-replaces-scrollbar={replacesScrollbar ? "" : undefined}
      activeIndex={activeIndex}
      aria-label="Conversation outline"
      // From `md`, the transcript has side padding that holds the rail, so
      // it shows beside narrow transcripts too.
      className="absolute inset-y-8 left-1 z-20 hidden md:flex @min-[62rem]/chat:left-3"
      itemCount={items.length}
      inView={inView}
      onScrub={
        replacesScrollbar
          ? (index) => {
              const item = items[index];
              if (item) select(item.seq);
            }
          : undefined
      }
      ref={navRef}
    >
      {/* The list's right padding would cover text in a narrow transcript. */}
      <MessageOutlineList className="@max-[62rem]/chat:pr-0">
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
      />
    </MessageOutline>
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
}) {
  const { previewIndex } = useMessageOutline();
  const item =
    previewIndex === undefined ? undefined : props.items[previewIndex];
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
