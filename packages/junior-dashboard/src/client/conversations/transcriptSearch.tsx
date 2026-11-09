import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { DecorationItem } from "shiki/bundle/web";

import {
  messageRawText,
  type RenderedTranscriptEntry,
} from "./transcriptRenderModel";
import { transcriptFailureSearchText } from "./transcriptFailure";
import { stringifyPartValue } from "../format";
import { isPlatformShortcut } from "../keyboard";

// ─── Context ────────────────────────────────────────────────────────────────

type TranscriptSearchContextValue = {
  /** Raw query string as typed by the user. */
  query: string;
  /** Trimmed, lowercase query used for matching. */
  normalizedQuery: string;
  /** True when the normalised query is non-empty. */
  active: boolean;
  /** Index of the current match among the matching rows. */
  match: number;
  /**
   * The transcript list reports how many rows match, and how many matches
   * loaded history put before the first one it showed.
   */
  onMatches?(count: number, prepended: number): void;
};

const defaultValue: TranscriptSearchContextValue = {
  query: "",
  normalizedQuery: "",
  active: false,
  match: 0,
};

const TranscriptSearchContext =
  createContext<TranscriptSearchContextValue>(defaultValue);

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
  const normalizedQuery = query.trim().toLowerCase();
  return (
    <TranscriptSearchContext.Provider
      value={{
        query,
        normalizedQuery,
        active: normalizedQuery.length > 0,
        match,
        onMatches,
      }}
    >
      {children}
    </TranscriptSearchContext.Provider>
  );
}

export function useTranscriptSearch() {
  return useContext(TranscriptSearchContext);
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

/** Returns true if any rendered field in the entry contains the normalised query. */
export function entryMatchesSearch(
  entry: RenderedTranscriptEntry,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;

  if (entry.kind === "message") {
    return (
      textContains(entry.message.trustedSummary, normalizedQuery) ||
      textContains(entry.message.eventType, normalizedQuery) ||
      textContains(messageRawText(entry.message), normalizedQuery)
    );
  }

  if (entry.kind === "failure") {
    return textContains(
      transcriptFailureSearchText(
        entry.failureCode,
        entry.failureReason,
        entry.eventId,
      ),
      normalizedQuery,
    );
  }

  if (entry.kind === "tool") {
    return [
      entry.part.name,
      entry.part.status,
      stringifyPartValue(entry.part.input),
      stringifyPartValue(entry.part.output),
    ].some((value) => textContains(value, normalizedQuery));
  }

  if (entry.kind === "reasoning") {
    return textContains(
      entry.part.redacted ? "reasoning redacted" : entry.part.text,
      normalizedQuery,
    );
  }

  if (entry.kind === "subagent") {
    return (
      textContains(
        entry.part.agentName ?? entry.part.subagentKind,
        normalizedQuery,
      ) ||
      textContains(entry.part.title, normalizedQuery) ||
      textContains(entry.part.task, normalizedQuery) ||
      textContains(entry.part.status, normalizedQuery)
    );
  }

  if (entry.kind === "structured_event") {
    const presentation = entry.part.presentation;
    return [
      presentation.title,
      presentation.preview,
      ...(presentation.details ?? []).flatMap((detail) => [
        detail.title,
        detail.description,
        detail.content,
        ...(detail.metadata ?? []),
      ]),
    ].some((value) => textContains(value, normalizedQuery));
  }

  if (entry.kind === "attachments_delivered") {
    return entry.part.attachments.some(
      (attachment) =>
        textContains(attachment.filename, normalizedQuery) ||
        textContains(attachment.contentType, normalizedQuery),
    );
  }

  if (entry.kind === "context") {
    const event = entry.part.event;
    return ["context compacted", event.summary].some((value) =>
      textContains(value, normalizedQuery),
    );
  }

  return false;
}

function textContains(text: string | undefined, query: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(query);
}
