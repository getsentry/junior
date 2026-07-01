import type {
  ConversationCompaction,
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { MAX_EXCERPT_CHARS } from "@/chat/tools/transcripts/constants";
import type { TranscriptAccess } from "@/chat/tools/transcripts/access";

function authorLabel(message: ConversationMessage): string | undefined {
  return (
    message.author?.fullName ??
    message.author?.userName ??
    message.author?.userId
  );
}

/** Format a timestamp in model-visible ISO-8601 form when present. */
export function isoTime(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function excerptAroundQuery(text: string, query: string | undefined): string {
  const compacted = compactWhitespace(text);
  if (compacted.length <= MAX_EXCERPT_CHARS) {
    return compacted;
  }

  const normalizedQuery = query?.trim().toLowerCase();
  const lower = compacted.toLowerCase();
  let index = normalizedQuery ? lower.indexOf(normalizedQuery) : -1;
  if (index < 0 && normalizedQuery) {
    for (const term of normalizedQuery.split(/\s+/)) {
      if (!term) continue;
      index = lower.indexOf(term);
      if (index >= 0) break;
    }
  }

  const center = index >= 0 ? index : 0;
  const start = Math.max(0, center - Math.floor(MAX_EXCERPT_CHARS / 3));
  const end = Math.min(compacted.length, start + MAX_EXCERPT_CHARS);
  return `${start > 0 ? "..." : ""}${compacted.slice(start, end)}${end < compacted.length ? "..." : ""}`;
}

/** Project a retained live message into the model-visible transcript result shape. */
export function projectMessage(args: {
  link?: string;
  message: ConversationMessage;
  query?: string;
}) {
  return {
    id: args.message.id,
    role: args.message.role,
    text: args.message.text,
    excerpt: excerptAroundQuery(args.message.text, args.query),
    created_at: isoTime(args.message.createdAtMs),
    source_message_id: args.message.meta?.slackTs,
    author: authorLabel(args.message),
    ...(args.link ? { link: args.link } : {}),
  };
}

/** Project a retained compaction summary into the model-visible transcript result shape. */
export function projectCompaction(args: {
  compaction: ConversationCompaction;
  query?: string;
}) {
  return {
    id: args.compaction.id,
    summary: args.compaction.summary,
    excerpt: excerptAroundQuery(args.compaction.summary, args.query),
    created_at: isoTime(args.compaction.createdAtMs),
    covered_message_count: args.compaction.coveredMessageIds.length,
  };
}

/** Count retained live and compacted messages for transcript read summaries. */
export function retainedMessageCount(state: ThreadConversationState): number {
  return (
    state.messages.length +
    state.compactions.reduce(
      (total, compaction) => total + compaction.coveredMessageIds.length,
      0,
    )
  );
}

/** Wrap a transcript summary object in the standard tool response shape. */
export function resultContent(summary: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    details: summary,
  };
}

/** Return a deterministic input-style transcript tool error. */
export function inputError(error: string) {
  return { ok: false, error };
}

/** Project conversation metadata plus retained state counts for list results. */
export function transcriptSummary(args: {
  access: TranscriptAccess;
  link?: string;
  state: ThreadConversationState;
}) {
  const latestMessage = [...args.state.messages]
    .reverse()
    .find((message) => message.text.trim().length > 0);
  return {
    conversation_id: args.access.conversation.conversationId,
    destination: args.access.destination,
    display_name: args.access.conversation.channelName,
    title: args.access.conversation.title,
    created_at: isoTime(args.access.conversation.createdAtMs),
    last_activity_at: isoTime(args.access.conversation.lastActivityAtMs),
    message_count: args.state.messages.length,
    compaction_count: args.state.compactions.length,
    ...(args.link ? { link: args.link } : {}),
    ...(latestMessage
      ? {
          latest_message: {
            role: latestMessage.role,
            author: authorLabel(latestMessage),
            created_at: isoTime(latestMessage.createdAtMs),
            excerpt: excerptAroundQuery(latestMessage.text, undefined),
          },
        }
      : {}),
  };
}
