/**
 * A Lead acts as its person, so its team is every public root where its
 * person is a Participant, next to the child agents of other agents
 * (`design/agent-teams.md`). A root has no parent and stores no link to the
 * Lead: the Lead manages it as its person could.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { conversationKindSql } from "@/chat/conversations/sql/conversation-row";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";

/** Bound the roots that one listing reads, like child agents. */
const LEAD_ROOT_LIST_LIMIT = 200;

// Public roots where the person of the Lead is a Participant. The Lead may
// read only public roots (`policies/conversation-access.md`).
function leadTeamRoots(leadConversationId: string) {
  const lead = alias(juniorConversations, "lead");
  return getSqlExecutor()
    .db()
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      status: juniorConversations.executionStatus,
      stoppedAt: juniorConversations.stoppedAt,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorDestinations,
      and(
        eq(juniorDestinations.id, juniorConversations.destinationId),
        eq(juniorDestinations.visibility, "public"),
      ),
    )
    .innerJoin(
      juniorConversationParticipants,
      eq(
        juniorConversationParticipants.rootConversationId,
        juniorConversations.conversationId,
      ),
    )
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.userId, juniorConversationParticipants.userId),
    )
    .innerJoin(
      lead,
      and(
        eq(lead.actorIdentityId, juniorIdentities.id),
        eq(lead.conversationId, leadConversationId),
        eq(lead.kind, "lead"),
      ),
    )
    .$dynamic();
}

// Rows from older deploys have no kind; decode them like other readers.
const isRoot = eq(conversationKindSql(juniorConversations), "root");

/** Return whether a root is on the team of one Lead. */
export async function isLeadTeamRoot(args: {
  conversationId: string;
  leadConversationId: string;
}): Promise<boolean> {
  const [row] = await leadTeamRoots(args.leadConversationId)
    .where(
      and(eq(juniorConversations.conversationId, args.conversationId), isRoot),
    )
    .limit(1);
  return row !== undefined;
}

/** One root on the team of a Lead. */
export type LeadRoot = {
  archivedAtMs?: number;
  conversationId: string;
  status: ConversationStatus;
  stoppedAtMs?: number;
  title?: string;
  updatedAtMs: number;
};

/** List the roots on the team of one Lead, with the newest activity first. */
export async function listLeadRoots(
  leadConversationId: string,
): Promise<LeadRoot[]> {
  const updatedAt = sql<Date>`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`;
  const rows = await leadTeamRoots(leadConversationId)
    .where(isRoot)
    .orderBy(desc(updatedAt))
    .limit(LEAD_ROOT_LIST_LIMIT);
  return rows.map((row) => ({
    ...(row.archivedAt
      ? { archivedAtMs: row.archivedAt.getTime() }
      : undefined),
    conversationId: row.conversationId,
    status: row.status,
    ...(row.stoppedAt ? { stoppedAtMs: row.stoppedAt.getTime() } : undefined),
    ...(row.title ? { title: row.title } : undefined),
    updatedAtMs: (row.executionUpdatedAt ?? row.updatedAt).getTime(),
  }));
}
