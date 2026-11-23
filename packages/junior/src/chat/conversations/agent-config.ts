import { eq } from "drizzle-orm";
import * as z from "zod";
import { agentTypeSchema } from "@/chat/agent-invocations/agent-types";
import { getSqlExecutor } from "@/chat/db";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { juniorConversations } from "@/db/schema";

/**
 * The agent settings that every Turn of one Conversation keeps, for any
 * kind: its Agent type, its reasoning level, and whether it started with its
 * parent's history. A kind sets only the fields that apply to it.
 */
export const agentConfigSchema = z
  .object({
    agentType: agentTypeSchema.optional(),
    fork: z.literal(true).optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
  })
  .strict();

export type AgentConfig = z.output<typeof agentConfigSchema>;

/**
 * Read the agent config that one Conversation stores, or undefined when it
 * stores none. Today only a child agent stores one.
 */
export async function readAgentConfig(
  conversationId: string,
): Promise<AgentConfig | undefined> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ agentConfig: juniorConversations.agentConfig })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return row?.agentConfig
    ? agentConfigSchema.parse(row.agentConfig)
    : undefined;
}
