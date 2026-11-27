import { and, isNull, ne, or, type SQL } from "drizzle-orm";
import { juniorConversations } from "@/db/schema";

/** Match top-level Conversations: tree roots, with no parent. */
export function topLevelConversation(): SQL {
  return isNull(juniorConversations.parentConversationId);
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
 * Match Conversations that lists and searches may show: roots that are not
 * an unkept Quick question or a Lead. Each list adds its own access and scope
 * filters. Structural root checks, such as retention, do not use this.
 */
export function listedConversation(): SQL {
  return and(
    topLevelConversation(),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
    notLeadConversation(),
  )!;
}
