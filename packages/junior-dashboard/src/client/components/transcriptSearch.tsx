import { type ReactNode, createContext, useContext } from "react";
import type { DecorationItem } from "shiki/bundle/web";

import { stringifyPartValue } from "../format";
import { conversationTranscriptMessages } from "../transcriptActivity";
import type { ConversationTranscript } from "../types";
import {
  groupTranscriptMessages,
  messageRawText,
  type RenderedTranscriptEntry,
} from "./transcriptRenderModel";

// ─── Context ────────────────────────────────────────────────────────────────

type TranscriptSearchContextValue = {
  /** Raw query string as typed by the user. */
  query: string;
  /** Trimmed, lowercase query used for matching. */
  normalizedQuery: string;
  /** True when the normalised query is non-empty. */
  active: boolean;
};

const defaultValue: TranscriptSearchContextValue = {
  query: "",
  normalizedQuery: "",
  active: false,
};

const TranscriptSearchContext =
  createContext<TranscriptSearchContextValue>(defaultValue);

export function TranscriptSearchProvider({
  children,
  query,
}: {
  children: ReactNode;
  query: string;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  return (
    <TranscriptSearchContext.Provider
      value={{ query, normalizedQuery, active: normalizedQuery.length > 0 }}
    >
      {children}
    </TranscriptSearchContext.Provider>
  );
}

export function useTranscriptSearch() {
  return useContext(TranscriptSearchContext);
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
        className="rounded-[2px] bg-amber-400/20 px-0.5 text-inherit not-italic"
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
    return textContains(messageRawText(entry.message), normalizedQuery);
  }

  if (entry.kind === "tool") {
    const visibleCallStatus =
      entry.call?.status === "running" && !entry.result
        ? entry.call.status
        : undefined;
    return (
      textContains(entry.call?.name, normalizedQuery) ||
      textContains(visibleCallStatus, normalizedQuery) ||
      textContains(entry.result?.name, normalizedQuery) ||
      textContains(stringifyPartValue(entry.call?.input), normalizedQuery) ||
      textContains(stringifyPartValue(entry.result?.output), normalizedQuery)
    );
  }

  if (entry.kind === "subagent") {
    return (
      textContains(entry.part.subagentKind, normalizedQuery) ||
      textContains(entry.part.id, normalizedQuery) ||
      textContains(entry.part.status, normalizedQuery) ||
      textContains(entry.part.outcome, normalizedQuery) ||
      textContains(entry.part.parentToolCallId, normalizedQuery)
    );
  }

  if (entry.kind === "thinking") {
    return textContains(stringifyPartValue(entry.part.output), normalizedQuery);
  }

  if (entry.kind === "context") {
    const event = entry.part.event;
    return event.type === "model_handoff"
      ? textContains("model handoff", normalizedQuery) ||
          textContains(event.fromModelId, normalizedQuery) ||
          textContains(event.toModelId, normalizedQuery) ||
          textContains(event.summary, normalizedQuery)
      : textContains("context compacted", normalizedQuery) ||
          textContains(event.modelId, normalizedQuery) ||
          textContains(event.summary, normalizedQuery);
  }

  return false;
}

/** Returns true if the conversation has at least one entry matching the normalised query. */
export function conversationHasMatch(
  conversation: ConversationTranscript,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  return groupTranscriptMessages(
    conversationTranscriptMessages(conversation),
  ).some((entry) => entryMatchesSearch(entry, normalizedQuery));
}

function textContains(text: string | undefined, query: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(query);
}
