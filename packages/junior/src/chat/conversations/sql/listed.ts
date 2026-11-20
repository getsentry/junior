import { and, isNull, type SQL } from "drizzle-orm";
import { juniorConversations } from "@/db/schema";

/**
 * Match Conversations that lists and searches may show: roots that are not
 * an unkept Quick question. Each list adds its own access and scope filters.
 * Structural root checks, such as retention, do not use this.
 */
export function listedConversation(): SQL {
  return and(
    isNull(juniorConversations.parentConversationId),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
  )!;
}
