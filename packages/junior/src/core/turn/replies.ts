// The replies of a Turn: its steps' assistant messages that deliver text.
// Each step event's idempotency key names its Turn, so a Turn's replies are
// found without reading the rest of the Conversation history.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { markdownNodes, parseMarkdown } from "@sentry/junior-plugin-api";
import { and, asc, eq, like } from "drizzle-orm";
import { eventFromRow } from "@/chat/conversations/sql/history";
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import type { EngineContext } from "@/core/engine-context";
import { juniorConversationEvents } from "@/db/schema";

type EventRow = typeof juniorConversationEvents.$inferSelect;

// History from before the `noReply` tool ends some Turns with these markers,
// and a model that reads it can copy one as its whole reply. Remove them when
// no Conversation has main-era history left.
const LEGACY_NO_REPLY_MARKERS: readonly string[] = [
  "[[NO_REPLY]]",
  "[[QUIET]]",
];

// The model's own `<thinking>` text in a reply, not a prompt tag.
const THINKING_BLOCK_PATTERN =
  // oxlint-disable-next-line junior/no-prompt-tag-matching
  /[ \t]*<thinking\b[^>]*>[\s\S]*?<\/thinking>[ \t]*(?:\r?\n)?/gi;

// A fenced code block with a closing fence. A fence with no closing line runs
// to the end of the text, so keeping it would also keep any later thinking.
function isClosedFence(source: string): boolean {
  const opener = source.trimStart();
  const marker = opener.startsWith("```")
    ? "`"
    : opener.startsWith("~~~")
      ? "~"
      : undefined;
  const lastLine = source.lastIndexOf("\n");
  let closer = lastLine < 0 ? "" : source.slice(lastLine + 1).trim();
  // A fence inside a quote has the quote markers before its closer.
  while (closer.startsWith(">")) closer = closer.slice(1).trimStart();
  return (
    marker !== undefined &&
    closer.length >= 3 &&
    closer === marker.repeat(closer.length)
  );
}

// Removes leaked `<thinking>` blocks outside closed fenced code, so a code
// example that shows the tag stays intact.
function stripThinking(text: string): string {
  let result = "";
  let cursor = 0;
  for (const { position } of markdownNodes(parseMarkdown(text), ["code"])) {
    const start = position?.start.offset ?? 0;
    const end = position?.end.offset ?? 0;
    if (!isClosedFence(text.slice(start, end))) {
      continue;
    }
    result += text.slice(cursor, start).replace(THINKING_BLOCK_PATTERN, "");
    result += text.slice(start, end);
    cursor = end;
  }
  return result + text.slice(cursor).replace(THINKING_BLOCK_PATTERN, "");
}

/**
 * The text that an assistant message delivers to a person, or undefined when
 * it is no reply. Text next to a tool call is the model working, not a reply.
 */
export function assistantReplyText(
  message: AssistantMessage,
): string | undefined {
  if (message.content.some((part) => part.type === "toolCall")) {
    return undefined;
  }
  const text = stripThinking(
    message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n"),
  ).trim();
  return text && !LEGACY_NO_REPLY_MARKERS.includes(text) ? text : undefined;
}

/** The key prefix of the message events that a Turn's steps wrote. */
export function turnEventKeyPrefix(turnId: string): string {
  return `step:${turnId}:`;
}

/** The text that a message event delivers, or undefined when it is no reply. */
export function replyText(row: EventRow): string | undefined {
  const { data } = eventFromRow(row);
  if (data.type !== "assistant_message") {
    return undefined;
  }
  const message = piMessageFromHistoryItem(data);
  return message.role === "assistant" ? assistantReplyText(message) : undefined;
}

/** Finds the reply events of a Turn, in history order. */
export async function findTurnReplies(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  turnId: string,
): Promise<EventRow[]> {
  const events = await executor
    .db()
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "assistant_message"),
        like(
          juniorConversationEvents.idempotencyKey,
          `${turnEventKeyPrefix(turnId)}%`,
        ),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  return events.filter((row) => replyText(row) !== undefined);
}
