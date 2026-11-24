/**
 * The roots that a Lead started are on its team, next to the child agents
 * of other agents (`design/agent-teams.md`). A root stores its Lead, not a
 * parent: it has no parent, and it runs as the Lead's person.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { ConversationStatus } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";
import { TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE } from "./top-level-message";

/** Bound the roots that one listing reads, like child agents. */
const LEAD_ROOT_LIST_LIMIT = 200;

/** One root that a Lead started. */
export type LeadRoot = {
  archivedAtMs?: number;
  conversationId: string;
  status: ConversationStatus;
  stoppedAtMs?: number;
  title?: string;
  updatedAtMs: number;
};

/** List the roots that one Lead started, with the newest activity first. */
export async function listLeadRoots(
  leadConversationId: string,
): Promise<LeadRoot[]> {
  const updatedAt = sql<Date>`coalesce(${juniorConversations.executionUpdatedAt}, ${juniorConversations.updatedAt})`;
  const rows = await getSqlExecutor()
    .db()
    .select({
      archivedAt: juniorConversations.archivedAt,
      conversationId: juniorConversations.conversationId,
      status: juniorConversations.executionStatus,
      stoppedAt: juniorConversations.stoppedAt,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.leadConversationId, leadConversationId))
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

/**
 * Read when a Lead last gave one of its roots work: its brief, or its
 * latest message. The brief is the root's first Message.
 */
export async function readLastLeadWorkAtMs(args: {
  leadConversationId: string;
  rootConversationId: string;
}): Promise<number | undefined> {
  const payload = juniorConversationEvents.payload;
  const [row] = await getSqlExecutor()
    .db()
    .select({ createdAt: juniorConversationEvents.createdAt })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, args.rootConversationId),
        eq(juniorConversationEvents.type, "message"),
        sql`((${payload}->'meta'->>'fromLead') = 'true' or ((${payload}->'meta'->>'eventType') = ${TOP_LEVEL_AGENT_MESSAGE_EVENT_TYPE} and (${payload}->'meta'->>'eventIdentifier') = ${args.leadConversationId}))`,
      ),
    )
    .orderBy(desc(juniorConversationEvents.createdAt))
    .limit(1);
  return row?.createdAt.getTime();
}
