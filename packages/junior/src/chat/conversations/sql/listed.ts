import { and, isNull, sql, type SQL } from "drizzle-orm";
import {
  juniorConversations,
  juniorWalkthroughQuestions,
  juniorWalkthroughVersions,
} from "@/db/schema";

/**
 * Match Conversations that lists and searches may show: roots that are not
 * an unkept Quick question, a Walkthrough generation, or a reviewer's
 * questions about a Walkthrough. Each list adds its own access and scope
 * filters. Structural root checks, such as retention, do not use this.
 */
export function listedConversation(): SQL {
  return and(
    isNull(juniorConversations.parentConversationId),
    // An unkept Quick question is a private side thread.
    isNull(juniorConversations.quickQuestionAt),
    // A Walkthrough generation is host work that the Walkthrough page shows.
    // The unique index on generation_conversation_id serves this lookup.
    sql`NOT EXISTS (SELECT 1 FROM ${juniorWalkthroughVersions} WHERE ${juniorWalkthroughVersions.generationConversationId} = ${juniorConversations.conversationId})`,
    // The Walkthrough page shows these too. The unique index on
    // conversation_id serves this lookup.
    sql`NOT EXISTS (SELECT 1 FROM ${juniorWalkthroughQuestions} WHERE ${juniorWalkthroughQuestions.conversationId} = ${juniorConversations.conversationId})`,
  )!;
}
