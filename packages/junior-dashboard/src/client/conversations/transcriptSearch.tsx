import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DecorationItem } from "shiki/bundle/web";

import {
  messageRawText,
  type RenderedTranscriptEntry,
} from "./transcriptRenderModel";
import { scrollRootFor } from "./transcriptBottomPinning";
import { isPlatformShortcut } from "../keyboard";

// ─── Context ────────────────────────────────────────────────────────────────

type TranscriptSearchContextValue = {
  /** Trimmed, lowercase query used for matching. */
  normalizedQuery: string;
  /** True when the normalised query is non-empty. */
  active: boolean;
};

type TranscriptSearchStepValue = {
  /** Index of the current match among the matching rows. */
  match: number;
  /**
   * The transcript list reports how many rows match, and how many matches
   * loaded history put before the first one it showed.
   */
  onMatches?(count: number, prepended: number): void;
};

const TranscriptSearchContext = createContext<TranscriptSearchContextValue>({
  normalizedQuery: "",
  active: false,
});

// The current match is apart from the query, so a step renders the list
// again, not every highlight in it.
const TranscriptSearchStepContext = createContext<TranscriptSearchStepValue>({
  match: 0,
});

/**
 * Share one search with the rows below. Rows match and highlight a
 * deferred query, so typing stays responsive in a long transcript.
 */
export function TranscriptSearchProvider({
  children,
  match = 0,
  onMatches,
  query,
}: {
  children: ReactNode;
  match?: number;
  onMatches?(count: number, prepended: number): void;
  query: string;
}) {
  const deferredQuery = useDeferredValue(query);
  // Clearing search applies at once: a jump clears search and then looks
  // for its row in the same render.
  const normalizedQuery = (query.trim() ? deferredQuery : query)
    .trim()
    .toLowerCase();
  const search = useMemo(
    () => ({ normalizedQuery, active: normalizedQuery.length > 0 }),
    [normalizedQuery],
  );
  const step = useMemo(() => ({ match, onMatches }), [match, onMatches]);
  return (
    <TranscriptSearchContext.Provider value={search}>
      <TranscriptSearchStepContext.Provider value={step}>
        {children}
      </TranscriptSearchStepContext.Provider>
    </TranscriptSearchContext.Provider>
  );
}

/** The active search query, for matching and highlighting. */
export function useTranscriptSearch() {
  return useContext(TranscriptSearchContext);
}

/**
 * Connect the transcript list to the search box. While search is active,
 * every row is a match. Report how many rows match, keep the current match
 * on its row when earlier history loads, and scroll to it when the reader
 * steps. Returns the index of the current match row.
 *
 * A new query or a loaded page does not scroll: a scroll to the top match
 * shows the history sentinel, and each loaded page would then load the
 * next one.
 */
export function useTranscriptSearchRows(input: {
  indexByKey: ReadonlyMap<string, number>;
  listRef: RefObject<HTMLElement | null>;
  /** The normalized query, when search is active. */
  query?: string;
  rows: readonly { key: string }[];
}): number | undefined {
  const { indexByKey, listRef, query, rows } = input;
  const { match, onMatches } = useContext(TranscriptSearchStepContext);
  const matchCount = query === undefined ? 0 : rows.length;
  const shown = useRef<{
    firstKey?: string;
    matchKey?: string;
    query?: string;
  }>({});
  useEffect(() => {
    const previous = shown.current;
    const sameQuery = previous.query === query;
    const prepended =
      matchCount > 0 && sameQuery && previous.firstKey !== undefined
        ? (indexByKey.get(previous.firstKey) ?? 0)
        : 0;
    const current = Math.min(match + prepended, matchCount - 1);
    const matchKey = matchCount > 0 ? rows[current]?.key : undefined;
    shown.current = { firstKey: rows[0]?.key, matchKey, query };
    onMatches?.(matchCount, prepended);
    if (
      !sameQuery ||
      matchKey === undefined ||
      matchKey === previous.matchKey
    ) {
      return;
    }
    const row = listRef.current?.querySelector(`[data-index="${current}"]`);
    const root = scrollRootFor(listRef.current);
    if (!row || !(root instanceof Element)) return;
    // Scroll only the transcript. When it cannot center the row,
    // scrollIntoView also scrolls the page layout and moves the header and
    // side panels.
    const rowBox = row.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    root.scrollTop +=
      rowBox.top - rootBox.top - (rootBox.height - rowBox.height) / 2;
  }, [indexByKey, listRef, match, matchCount, onMatches, query, rows]);
  return matchCount === 0 ? undefined : match;
}

/** The current match of one search box, and how many rows match. */
export type TranscriptSearchMatch = ReturnType<typeof useTranscriptSearchMatch>;

/**
 * Track the current match for `query`. A new query starts at the first
 * match. Steps wrap around at both ends.
 */
export function useTranscriptSearchMatch(query: string) {
  const [position, setPosition] = useState({ index: 0, query });
  const [count, setCount] = useState(0);
  const index =
    position.query === query
      ? Math.max(0, Math.min(position.index, count - 1))
      : 0;
  const setMatches = useCallback(
    (next: number, prepended: number) => {
      setCount(next);
      if (prepended === 0) return;
      // Earlier history put matches before the current one. Keep the same
      // row current.
      setPosition((current) => ({
        index: (current.query === query ? current.index : 0) + prepended,
        query,
      }));
    },
    [query],
  );
  return {
    count,
    index,
    setMatches,
    step(delta: 1 | -1) {
      if (count === 0) return;
      setPosition({ index: (index + delta + count) % count, query });
    },
  };
}

// ─── Find shortcut ───────────────────────────────────────────────────────────

/**
 * Take ⌘F / Ctrl+F for transcript search. The first press opens or focuses
 * the search box; a press while the search box has focus goes to the
 * browser's find. Only the search in the front layer (the page, or the
 * topmost drawer or dialog) takes the shortcut.
 */
export function useTranscriptFindShortcut(props: {
  /** Element in the search's layer, such as its toggle button. */
  anchorRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen(): void;
  open: boolean;
}) {
  const { anchorRef, inputRef, onOpen, open } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPlatformShortcut(event, "f")) return;
      const input = inputRef.current;
      // A new press in the search box goes to the browser's find. A key
      // repeat from holding the keys does not.
      if (input && document.activeElement === input && !event.repeat) return;
      if (!inFrontLayer(anchorRef.current)) return;
      event.preventDefault();
      if (event.repeat) return;
      if (open && input) {
        input.focus();
        input.select();
        return;
      }
      onOpen();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [anchorRef, inputRef, onOpen, open]);
}

function inFrontLayer(element: HTMLElement | null): boolean {
  if (!element) return false;
  const modals = document.querySelectorAll("[data-dashboard-modal]");
  const front = modals[modals.length - 1] ?? null;
  return element.closest("[data-dashboard-modal]") === front;
}

// ─── Inline highlighting ─────────────────────────────────────────────────────

/** Renders plain text with case-insensitive query matches wrapped in a highlight mark. */
export function HighlightText({ text }: { text: string }) {
  const { normalizedQuery, active } = useTranscriptSearch();

  if (!active || !text) return <>{text}</>;

  const lower = text.toLowerCase();
  if (!lower.includes(normalizedQuery)) return <>{text}</>;

  const parts: ReactNode[] = [];
  let last = 0;
  let idx = lower.indexOf(normalizedQuery);
  let key = 0;

  while (idx !== -1) {
    if (idx > last) {
      parts.push(text.slice(last, idx));
    }
    parts.push(
      <mark
        key={key++}
        className="rounded-[2px] bg-amber-400/20 text-inherit not-italic"
      >
        {text.slice(idx, idx + normalizedQuery.length)}
      </mark>,
    );
    last = idx + normalizedQuery.length;
    idx = lower.indexOf(normalizedQuery, last);
  }

  if (last < text.length) {
    parts.push(text.slice(last));
  }

  return <>{parts}</>;
}

// ─── Shiki decorations ───────────────────────────────────────────────────────

/** Build Shiki DecorationItems for all case-insensitive matches of the query in text. */
export function buildSearchDecorations(
  text: string,
  normalizedQuery: string,
): DecorationItem[] {
  if (!normalizedQuery || !text) return [];

  const lower = text.toLowerCase();
  const decorations: DecorationItem[] = [];
  let idx = lower.indexOf(normalizedQuery);

  while (idx !== -1) {
    decorations.push({
      end: idx + normalizedQuery.length,
      properties: { class: "search-match" },
      start: idx,
      tagName: "mark",
    });
    idx = lower.indexOf(normalizedQuery, idx + normalizedQuery.length);
  }

  return decorations;
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Returns true if a message row contains the normalised query. Search
 * finds what people and Junior said, so tool calls, reasoning, child
 * agents, failures, and other activity rows never match.
 */
export function entryMatchesSearch(
  entry: RenderedTranscriptEntry,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  if (entry.kind !== "message") return false;
  const { message } = entry;
  return [
    message.trustedSummary,
    message.eventType,
    messageRawText(message),
  ].some((text) => text?.toLowerCase().includes(normalizedQuery));
}
