import type { User } from "@sentry/junior-plugin-api";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { loadConversationSlackTenantIds } from "@/chat/conversations/sql/event-actor";
import { juniorConversationEvents } from "@/db/schema";
import { resolveMentions } from "../mentions";
import {
  CONVERSATION_OUTLINE_TEXT_LENGTH,
  type ConversationOutline,
} from "../schema/conversation-outline";
import { readConversationAccessFromSql } from "./access";

const payload = juniorConversationEvents.payload;

/**
 * List the person messages of a whole Conversation for the dashboard
 * outline. The dashboard transcript loads only the latest pages, so the
 * outline cannot build its items from the loaded rows alone.
 *
 * It uses the same rules as the transcript: Event messages are not person
 * messages, and a message that does not mention Junior is thread context.
 * The `message_role_idx` index reads only this Conversation's user
 * messages, so the cost grows with the person messages, not all events.
 */
export async function readConversationOutline(
  conversationId: string,
  options: { viewer?: User } = {},
): Promise<ConversationOutline | undefined> {
  const access = (
    await readConversationAccessFromSql(
      getDb(),
      [conversationId],
      options.viewer,
    )
  ).get(conversationId);
  if (!access) return undefined;
  if (!access.canViewPrivateContent) return { items: [] };

  const rows = await getDb()
    .select({
      seq: juniorConversationEvents.seq,
      text: sql<string>`left(${payload}->>'text', ${CONVERSATION_OUTLINE_TEXT_LENGTH})`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        // A literal, not a parameter: a generic plan can use the partial
        // index only when the query states its predicate.
        sql`${juniorConversationEvents.type} = 'message'`,
        sql`${payload}->>'role' = 'user'`,
        sql`${payload}->'meta'->>'eventType' is null`,
        sql`coalesce(${payload}->'meta'->>'explicitMention', 'true') <> 'false'`,
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  const items = rows.flatMap((row) => {
    const text = withoutCutMention(row.text).trim();
    return text ? [{ seq: row.seq, text }] : [];
  });

  const tenantId = (
    await loadConversationSlackTenantIds(getSqlExecutor(), [conversationId])
  ).get(conversationId);
  const mentions = await resolveMentions(
    getSqlExecutor(),
    items.map((item) => ({ tenantId, texts: [item.text] })),
  );
  return {
    items: items.map((item, index) =>
      mentions[index]!.length > 0
        ? { ...item, mentions: mentions[index]! }
        : item,
    ),
  };
}

/** Drop a Slack token, such as `<@U123>`, that the length cut split. */
function withoutCutMention(text: string): string {
  return text.length < CONVERSATION_OUTLINE_TEXT_LENGTH
    ? text
    : text.replace(/<[^<>]*$/, "");
}
