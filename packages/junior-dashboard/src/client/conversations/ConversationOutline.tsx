import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
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
  MessageOutlinePreviewTitle,
  useMessageOutline,
} from "../components/ui/message-outline";
import { fetchDashboardJson } from "../http";
import {
  conversationOutlineItems,
  mergeConversationOutlineItems,
  outlineItemAtSeq,
  type ConversationOutlineItem,
} from "./conversationOutlineItems";
import { transcriptMessagesFromEvents } from "./eventTranscript";

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
 */
export function ConversationOutline(props: {
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
  const activeSeq = useActiveOutlineSeq(items, scrollRef);
  const [jumpSeq, setJumpSeq] = useState<number>();

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
      activeIndex={items.findIndex((item) => item.seq === activeSeq)}
      aria-label="Conversation outline"
      className="absolute inset-y-8 left-3 z-20 hidden @min-[62rem]/chat:flex"
      itemCount={items.length}
    >
      <MessageOutlineList>
        {items.map((item, index) => (
          <MessageOutlineItem
            aria-label={item.title}
            index={index}
            key={item.seq}
            onClick={() => {
              props.onSelect(item.seq);
              setJumpSeq(item.seq);
            }}
          />
        ))}
      </MessageOutlineList>
      <ConversationOutlinePreview items={items} />
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

/** Preview the pointed message with the last Junior reply to it. */
function ConversationOutlinePreview(props: {
  items: readonly ConversationOutlineItem[];
}) {
  const { previewIndex } = useMessageOutline();
  const item =
    previewIndex === undefined ? undefined : props.items[previewIndex];
  if (!item) return null;
  return (
    <MessageOutlinePreview>
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
 * Track the item whose section holds the top of the transcript viewport. The
 * transcript mounts only rows near the viewport, so this reads the seq of the
 * top mounted row, not the item rows themselves.
 */
function useActiveOutlineSeq(
  items: readonly ConversationOutlineItem[],
  scrollRef: RefObject<HTMLDivElement | null>,
): number | undefined {
  const [activeSeq, setActiveSeq] = useState<number>();
  const update = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const top = scroll.getBoundingClientRect().top + JUMP_MARGIN_PX;
    let topRowSeq: number | undefined;
    let topRowStart = Infinity;
    for (const row of scroll.querySelectorAll<HTMLElement>(
      "[data-transcript-seq]",
    )) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= top || rect.top >= topRowStart) continue;
      topRowStart = rect.top;
      topRowSeq = Number(row.dataset.transcriptSeq);
    }
    setActiveSeq(
      topRowSeq === undefined
        ? undefined
        : outlineItemAtSeq(items, topRowSeq)?.seq,
    );
  }, [items, scrollRef]);

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
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
    };
  }, [scrollRef, update]);

  return activeSeq;
}
