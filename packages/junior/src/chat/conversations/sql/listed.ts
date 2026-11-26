import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { juniorConversations } from "@/db/schema";

/**
 * Match top-level Conversations: one with no parent, or a Lead's child,
 * which is top-level Space work. Top-level lists show these. A Lead's child
 * is its own top-level Conversation, and its parent, the Lead, is its root.
 * A stray child that stores itself as both is not one.
 */
export function topLevelConversation(
  conversation: {
    conversationId: AnyPgColumn;
    parentConversationId: AnyPgColumn;
    rootConversationId: AnyPgColumn;
    topLevelConversationId: AnyPgColumn;
  } = juniorConversations,
): SQL {
  return or(
    isNull(conversation.parentConversationId),
    and(
      eq(conversation.topLevelConversationId, conversation.conversationId),
      eq(conversation.rootConversationId, conversation.parentConversationId),
    ),
  )!;
}

/**
 * Match Conversations that are not a Lead. Its Space's page opens the Lead,
 * so lists leave it out. Older rows have no kind.
 */
export function notLeadConversation(): SQL {
  return or(
    isNull(juniorConversations.kind),
    ne(juniorConversations.kind, "lead"),
  )!;
}

/**
 * Match Conversations that lists and searches may show: tree roots that are
 * not an unkept Quick question or a Lead. Each list adds its own access and
 * scope filters. Structural root checks, such as retention, do not use this.
 */
export function listedConversation(): SQL {
  return and(
    topLevelConversation(),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
    notLeadConversation(),
  )!;
}
