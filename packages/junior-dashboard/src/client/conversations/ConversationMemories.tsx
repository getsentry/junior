import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationDetailReport,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";
import { Brain } from "lucide-react";

import { formatMessageTimestamp } from "../format";

type CapturedMemory = {
  content: string;
  createdAt: string;
  metadata: string[];
  seq: number;
};

/** Project memories captured by the memory plugin from Conversation events. */
export function capturedMemoriesFromEvents(
  events: readonly ConversationReportEvent[],
): CapturedMemory[] {
  return events
    .filter(
      (event) =>
        event.data.type === "structured_event" &&
        event.data.namespace === "memory" &&
        event.data.name === "memories_captured",
    )
    .flatMap((event) => {
      if (event.data.type !== "structured_event") return [];
      return (event.data.presentation.details ?? []).map((detail) => ({
        content: detail.title,
        createdAt: event.createdAt,
        metadata: detail.metadata ?? [],
        seq: event.seq,
      }));
    })
    .sort((left, right) => right.seq - left.seq);
}

/** Load and show every memory captured from one Conversation. */
export function ConversationMemories(props: {
  active: boolean;
  initialConversation?: ConversationDetailReport;
  loadConversation(): Promise<ConversationDetailReport>;
}) {
  const [conversation, setConversation] = useState(props.initialConversation);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadConversationRef = useRef(props.loadConversation);
  const loadStartedRef = useRef(false);
  loadConversationRef.current = props.loadConversation;

  useEffect(() => {
    if (!loadStartedRef.current) setConversation(props.initialConversation);
  }, [props.initialConversation]);

  useEffect(() => {
    if (
      !props.active ||
      loadStartedRef.current ||
      props.initialConversation?.previousCursor === undefined
    ) {
      return;
    }
    loadStartedRef.current = true;
    let current = true;
    setLoading(true);
    setError(false);
    void loadConversationRef
      .current()
      .then((complete) => {
        if (current) setConversation(complete);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [props.active, props.initialConversation?.previousCursor]);

  const memories = useMemo(
    () => capturedMemoriesFromEvents(conversation?.events ?? []),
    [conversation?.events],
  );

  if (loading) {
    return (
      <p className="m-0 text-sm text-dashboard-text-muted" role="status">
        Loading memories…
      </p>
    );
  }
  if (error) {
    return (
      <p className="m-0 text-sm text-red-300/80">
        Could not load the complete Conversation history.
      </p>
    );
  }
  if (memories.length === 0) {
    const unavailable =
      conversation && conversation.eventHistory.status !== "available";
    return (
      <div className="grid justify-items-center gap-2 py-10 text-center text-dashboard-text-muted">
        <Brain aria-hidden="true" className="size-5 opacity-60" />
        <p className="m-0 text-sm">
          {unavailable
            ? "Memory history is not available."
            : "No memories were captured."}
        </p>
      </div>
    );
  }

  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {memories.map((memory, memoryIndex) => (
        <li
          className="grid gap-2 rounded-lg border border-dashboard-border-subtle bg-dashboard-surface px-3 py-3"
          key={`${memory.seq}:${memoryIndex}`}
        >
          <p className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-dashboard-text">
            {memory.content}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-dashboard-text-muted">
            {memory.metadata.map((item, metadataIndex) => (
              <span
                className="rounded border border-dashboard-border-subtle bg-dashboard-surface-raised px-1.5 py-0.5"
                key={`${item}:${metadataIndex}`}
              >
                {item}
              </span>
            ))}
            <time className="ml-auto" dateTime={memory.createdAt}>
              {formatMessageTimestamp(Date.parse(memory.createdAt), true)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
