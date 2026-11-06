import { and, eq } from "drizzle-orm";
import { getSqlExecutor } from "@/chat/db";
import { juniorAgentBindings, juniorAgentInvocations } from "@/db/schema";
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

/** Find a direct child agent of one parent by name or child Conversation id. */
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
  const rows = await getSqlExecutor()
    .db()
    .select({ childConversationId: juniorAgentInvocations.childConversationId })
    .from(juniorAgentInvocations)
    .where(
      and(
        eq(
          juniorAgentInvocations.parentConversationId,
          args.parentConversationId,
        ),
        eq(juniorAgentInvocations.childConversationId, args.target),
      ),
    )
    .limit(1);
  return rows[0]?.childConversationId;
}
