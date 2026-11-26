import { and, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { juniorConversations } from "@/db/schema";

/**
 * Match top-level Conversations: one with no parent, or a Lead's child,
 * which is top-level Space work. Top-level lists show these.
 */
export function topLevelConversation(): SQL {
  // One read of the Leads, through `junior_conversations_space_lead_idx`,
  // for the whole query. Installs have few Spaces.
  return or(
    isNull(juniorConversations.parentConversationId),
    sql`${juniorConversations.parentConversationId} = any(array(
      select listed_lead.conversation_id
      from junior_conversations listed_lead
      where listed_lead.kind = 'lead'
        and listed_lead.space_id is not null
    ))`,
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
 * Match Conversations that lists and searches may show: top-level
 * Conversations that are not an unkept Quick question or a Lead. Each list adds its own access and
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
