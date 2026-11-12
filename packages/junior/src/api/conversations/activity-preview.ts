import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import type { ConversationActivityPreview } from "../schema/conversation";

/**
 * The latest non-empty message with one role in the outer Conversation. It
 * walks `junior_conversation_events_message_role_idx` from the newest
 * message and stops at the first match.
 */
function latestMessage(
  db: JuniorDatabase,
  role: ConversationActivityPreview["role"],
) {
  const text = sql<string>`${juniorConversationEvents.payload}->>'text'`;
  return db
    .select({
      createdAt: juniorConversationEvents.createdAt,
      text: text.as(`${role}_text`),
    })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(
          juniorConversationEvents.conversationId,
          juniorConversations.conversationId,
        ),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = ${role}`,
        isNotNull(sql`nullif(btrim(${text}), '')`),
      ),
    )
    .orderBy(
      desc(juniorConversationEvents.createdAt),
      desc(juniorConversationEvents.seq),
    )
    .limit(1)
    .as(`latest_${role}`);
}

/**
 * Return a query for the seq of the newest Message with one role in one
 * outer Conversation. The feed row's preview and participants come from
 * Messages, so it moves when they can change. It walks the same index as
 * the preview read, with no text check.
 */
export function latestMessageSeqQuery(
  db: JuniorDatabase,
  role: ConversationActivityPreview["role"],
  conversationId: SQLWrapper,
) {
  return db
    .select({ seq: juniorConversationEvents.seq })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.type, "message"),
        sql`${juniorConversationEvents.payload}->>'role' = ${role}`,
      ),
    )
    .orderBy(
      desc(juniorConversationEvents.createdAt),
      desc(juniorConversationEvents.seq),
    )
    .limit(1);
}

/** Read one recent assistant message, or the latest user message, for each conversation. */
export async function readConversationActivityPreviews(
  db: JuniorDatabase,
  conversationIds: string[],
): Promise<Map<string, ConversationActivityPreview>> {
  if (conversationIds.length === 0) return new Map();

  const assistant = latestMessage(db, "assistant");
  const user = latestMessage(db, "user");
  const rows = await db
    .select({
      conversationId: juniorConversations.conversationId,
      assistantAt: assistant.createdAt,
      assistantText: assistant.text,
      userAt: user.createdAt,
      userText: user.text,
    })
    .from(juniorConversations)
    .leftJoinLateral(assistant, sql`true`)
    .leftJoinLateral(user, sql`true`)
    .where(inArray(juniorConversations.conversationId, conversationIds));

  const previews = new Map<string, ConversationActivityPreview>();
  for (const row of rows) {
    const preview: ConversationActivityPreview | undefined =
      row.assistantAt && row.assistantText !== null
        ? {
            createdAt: row.assistantAt.toISOString(),
            role: "assistant",
            text: row.assistantText,
          }
        : row.userAt && row.userText !== null
          ? {
              createdAt: row.userAt.toISOString(),
              role: "user",
              text: row.userText,
            }
          : undefined;
    if (preview) previews.set(row.conversationId, preview);
  }
  return previews;
}
