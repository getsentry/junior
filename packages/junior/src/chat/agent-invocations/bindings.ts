import { and, eq, exists, isNotNull, or } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";
import { agentBindingSchema, type AgentBinding } from "./types";

function bindingFromRow(
  row: typeof juniorAgentBindings.$inferSelect,
): AgentBinding {
  return agentBindingSchema.parse({
    childConversationId: row.childConversationId,
    name: row.name,
    parentConversationId: row.parentConversationId,
  });
}

/** Read one named child binding in its parent-agent scope. */
export async function getAgentBinding(args: {
  name: string;
  parentConversationId: string;
}): Promise<AgentBinding | undefined> {
  const rows = await getSqlExecutor()
    .db()
    .select()
    .from(juniorAgentBindings)
    .where(
      and(
        eq(juniorAgentBindings.parentConversationId, args.parentConversationId),
        eq(juniorAgentBindings.name, args.name),
      ),
    );
  return rows[0] ? bindingFromRow(rows[0]) : undefined;
}

/**
 * Find a direct child agent of one parent by name or child Conversation id.
 * A child that no Agent invocation names stores its spawn options.
 */
export async function findChildAgentConversationId(args: {
  parentConversationId: string;
  target: string;
}): Promise<string | undefined> {
  const binding = await getAgentBinding({
    name: args.target,
    parentConversationId: args.parentConversationId,
  });
  if (binding) {
    return binding.childConversationId;
  }
  const db = getSqlExecutor().db();
  const rows = await db
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        eq(juniorConversations.parentConversationId, args.parentConversationId),
        eq(juniorConversations.conversationId, args.target),
        or(
          isNotNull(juniorConversations.spawnOptions),
          exists(
            db
              .select({ invocationId: juniorAgentInvocations.invocationId })
              .from(juniorAgentInvocations)
              .where(
                eq(juniorAgentInvocations.childConversationId, args.target),
              ),
          ),
        ),
      ),
    )
    .limit(1);
  return rows[0]?.conversationId;
}
