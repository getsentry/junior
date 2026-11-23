import type { User } from "@sentry/junior-plugin-api";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, getSqlExecutor } from "@/chat/db";
import { loadConversationSlackTenantIds } from "@/chat/conversations/sql/event-actor";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { juniorConversationEvents } from "@/db/schema";
import { resolveMentions } from "../mentions";
import {
  CONVERSATION_OUTLINE_TEXT_LENGTH,
  type ConversationOutline,
} from "../schema/conversation-outline";
import { readConversationAccessFromSql } from "./access";
import { reportParentAgentInput } from "./events";

const payload = juniorConversationEvents.payload;

/**
 * List the person messages of a whole Conversation, each with its author and
 * the start of Junior's reply, for the dashboard outline. The dashboard transcript loads
 * only the latest pages, so the outline cannot build its items from the
 * loaded rows alone.
 *
 * It uses the same rules as the transcript: Event messages are not person
 * messages, and a message that does not mention Junior is thread context.
 * The cost grows with the messages, not all events.
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

  const [rows, replies] = await Promise.all([
    readMessages(
      conversationId,
      "user",
      sql`${payload}->'meta'->>'eventType' is null`,
      sql`coalesce(${payload}->'meta'->>'explicitMention', 'true') <> 'false'`,
    ),
    readMessages(conversationId, "assistant"),
  ]);
  const items: ConversationOutline["items"] = rows.flatMap((row) => {
    const text = withoutCutToken(row.text).trim();
    if (!text) return [];
    return [
      {
        createdAt: row.createdAt.toISOString(),
        seq: row.seq,
        text,
        // The same author rule as the transcript events.
        ...(row.authorIdentityId && row.authorIdentityId !== SYSTEM_IDENTITY_ID
          ? { actorIdentityId: row.authorIdentityId }
          : undefined),
        // The same parent agent rule as the transcript events.
        ...reportParentAgentInput(row),
      },
    ];
  });
  // Like the transcript, an item's reply is the last Junior text before
  // the next item.
  let itemIndex = -1;
  for (const reply of replies) {
    while (items[itemIndex + 1] && items[itemIndex + 1]!.seq < reply.seq) {
      itemIndex += 1;
    }
    const text = withoutCutToken(reply.text).trim();
    if (itemIndex >= 0 && text) items[itemIndex]!.reply = text;
  }

  const tenantId = (
    await loadConversationSlackTenantIds(getSqlExecutor(), [conversationId])
  ).get(conversationId);
  const mentions = await resolveMentions(
    getSqlExecutor(),
    items.map((item) => ({ tenantId, texts: [item.text, item.reply] })),
  );
  return {
    items: items.map((item, index) =>
      mentions[index]!.length > 0
        ? { ...item, mentions: mentions[index]! }
        : item,
    ),
  };
}

/**
 * Read the cut text of one role's messages in seq order. The
 * `message_role_idx` index reads only these messages, not all events.
 */
function readMessages(
  conversationId: string,
  role: "assistant" | "user",
  ...filters: SQL[]
) {
  return getDb()
    .select({
      agentInvocationId: sql<
        string | null
      >`${payload}->'meta'->>'agentInvocationId'`,
      authorIdentityId: sql<
        string | null
      >`coalesce(${payload}->>'authorIdentityId', ${juniorConversationEvents.actorIdentityId})`,
      authorUserId: sql<string | null>`${payload}->'meta'->'author'->>'userId'`,
      createdAt: juniorConversationEvents.createdAt,
      messageId: sql<string>`${payload}->>'messageId'`,
      seq: juniorConversationEvents.seq,
      text: sql<string>`coalesce(left(${payload}->>'text', ${CONVERSATION_OUTLINE_TEXT_LENGTH}), '')`,
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        // A literal, not a parameter: a generic plan can use the partial
        // index only when the query states its predicate.
        sql`${juniorConversationEvents.type} = 'message'`,
        sql`${payload}->>'role' = ${role}`,
        ...filters,
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
}

/**
 * Repair a Slack token that the length cut split. A cut mention, such as
 * `<@U12`, cannot resolve, so it is dropped. A cut link keeps its URL text,
 * so a message that is only a long link still has a title.
 */
function withoutCutToken(text: string): string {
  return text.length < CONVERSATION_OUTLINE_TEXT_LENGTH
    ? text
    : text.replace(/<([^<>]*)$/, (_, token: string) =>
        /^[@#!]/.test(token) ? "" : token.split("|")[0]!,
      );
}
