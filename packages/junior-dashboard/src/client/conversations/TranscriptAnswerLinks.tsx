import { createContext, use, useSyncExternalStore } from "react";

import { reviewItemIdFromToolCall } from "../review-desk/reviewItemFormat";
import { cn } from "../styles";
import type { TranscriptListRow } from "./transcriptListRows";

/**
 * One question that Junior asked and the row of the person's answer, as
 * row indexes. `lane` keeps links that overlap on different lines.
 */
export type TranscriptAnswerLink = {
  answerIndex: number;
  askIndex: number;
  itemId: string;
  lane: number;
};

/**
 * Link each answer row to the row that asked its Review item. An answer is a
 * `submitted` change on a person's message. An Event message only relays a
 * change from somewhere else, so it is not an answer.
 */
export function transcriptAnswerLinks(
  rows: readonly TranscriptListRow[],
): TranscriptAnswerLink[] {
  const askIndexes = new Map<string, number>();
  const links: TranscriptAnswerLink[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== "entry") return;
    const { entry } = row;
    if (entry.kind === "tool") {
      const itemId = reviewItemIdFromToolCall(entry.part);
      if (itemId !== undefined) askIndexes.set(itemId, index);
      return;
    }
    if (entry.kind !== "message" || entry.message.eventType) return;
    for (const change of entry.message.reviewItemChanges ?? []) {
      const askIndex = askIndexes.get(change.reviewItemId);
      if (change.kind !== "submitted" || askIndex === undefined) continue;
      links.push({
        answerIndex: index,
        askIndex,
        itemId: change.reviewItemId,
        lane: 0,
      });
    }
  });
  // A link takes the first lane that is free at its question.
  const laneEnds: number[] = [];
  for (const link of [...links].sort((a, b) => a.askIndex - b.askIndex)) {
    const free = laneEnds.findIndex((end) => end < link.askIndex);
    link.lane = free < 0 ? laneEnds.length : free;
    laneEnds[link.lane] = link.answerIndex;
  }
  return links;
}

type LinkSegment = { lane: number; part: "start" | "middle" | "end" };

/**
 * Hold the rows that the list shows in its scroll pane, so an answer can
 * quote a question that is out of view. Make one for each transcript list.
 */
export function createVisibleRowsStore() {
  let range: { endIndex: number; startIndex: number } | null = null;
  const listeners = new Set<() => void>();
  return {
    shows: (index: number) =>
      range !== null && index >= range.startIndex && index <= range.endIndex,
    set(next: { endIndex: number; startIndex: number } | null) {
      if (
        range?.startIndex === next?.startIndex &&
        range?.endIndex === next?.endIndex
      ) {
        return;
      }
      range = next && { endIndex: next.endIndex, startIndex: next.startIndex };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type TranscriptAnswerLinksValue = {
  /** The row of each question that has an answer row. */
  askIndexes: ReadonlyMap<string, number>;
  segments: ReadonlyMap<number, readonly LinkSegment[]>;
  visibleRows: ReturnType<typeof createVisibleRowsStore>;
};

/** Build the context value of one transcript list from its links. */
export function transcriptAnswerLinksValue(
  links: readonly TranscriptAnswerLink[],
  visibleRows: TranscriptAnswerLinksValue["visibleRows"],
): TranscriptAnswerLinksValue {
  const segments = new Map<number, LinkSegment[]>();
  const add = (index: number, segment: LinkSegment) =>
    segments.set(index, [...(segments.get(index) ?? []), segment]);
  for (const link of links) {
    add(link.askIndex, { lane: link.lane, part: "start" });
    for (let index = link.askIndex + 1; index < link.answerIndex; index += 1) {
      add(index, { lane: link.lane, part: "middle" });
    }
    add(link.answerIndex, { lane: link.lane, part: "end" });
  }
  return {
    askIndexes: new Map(links.map((link) => [link.itemId, link.askIndex])),
    segments,
    visibleRows,
  };
}

/** The answer links of the transcript list that renders a row. */
export const TranscriptAnswerLinks = createContext<
  TranscriptAnswerLinksValue | undefined
>(undefined);

/** True when the question of an item has a row and an answer row. */
export function useAnswerLinked(itemId: string): boolean {
  return use(TranscriptAnswerLinks)?.askIndexes.has(itemId) ?? false;
}

const noRows = { shows: () => false, subscribe: () => () => {} };

/**
 * True while the scroll pane shows the row that asked an item. The list
 * knows its visible rows from layout, so this does not wait for the row to
 * mount or load its item.
 */
export function useAskInView(itemId: string): boolean {
  const value = use(TranscriptAnswerLinks);
  const askIndex = value?.askIndexes.get(itemId);
  const rows = value?.visibleRows ?? noRows;
  return useSyncExternalStore(
    rows.subscribe,
    () => askIndex !== undefined && rows.shows(askIndex),
  );
}

// Lanes sit inside the avatar column (1.5rem, 2rem from md), so each line
// ends behind the avatar of its answer.
const LANE_CLASSES = [
  "left-3 md:left-4",
  "left-1 md:left-1.5",
  "left-5 md:left-6.5",
];

// The row pads 0.375rem above and below. A question card ends there. The end
// segment reaches behind the avatar.
const PART_CLASSES = {
  end: "top-0 h-4 md:h-5",
  middle: "inset-y-0",
  start: "bottom-0 h-1.5",
} as const satisfies Record<LinkSegment["part"], string>;

/**
 * Draw the parts of the question and answer links that cross one row, in the
 * avatar column and behind the row content.
 */
export function TranscriptAnswerLinkSegments(props: { index: number }) {
  const segments = use(TranscriptAnswerLinks)?.segments.get(props.index);
  if (!segments) return null;
  return segments.map((segment) => (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -z-10 w-0.5 -translate-x-1/2 bg-dashboard-border-emphasis",
        LANE_CLASSES[segment.lane % LANE_CLASSES.length],
        PART_CLASSES[segment.part],
      )}
      key={`${segment.lane}:${segment.part}`}
    />
  ));
}
