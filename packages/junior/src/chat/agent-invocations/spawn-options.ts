import { eq } from "drizzle-orm";
import * as z from "zod";
import { getSqlExecutor } from "@/chat/db";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { juniorConversations } from "@/db/schema";
import { agentTypeSchema } from "./agent-types";

/**
 * The `spawnAgent` options that every Turn of one child agent keeps: its
 * Agent type, its reasoning level, and whether it started with its parent's
 * history.
 */
export const childSpawnOptionsSchema = z
  .object({
    agentType: agentTypeSchema.optional(),
    fork: z.literal(true).optional(),
    reasoningLevel: z.enum(TURN_REASONING_LEVELS).optional(),
  })
  .strict();

export type ChildSpawnOptions = z.output<typeof childSpawnOptionsSchema>;

/**
 * Read the spawn options that one child Conversation stores. A child that an
 * Agent invocation names reads them from its row first.
 */
export async function readChildSpawnOptions(
  childConversationId: string,
): Promise<ChildSpawnOptions> {
  const [row] = await getSqlExecutor()
    .db()
    .select({ spawnOptions: juniorConversations.spawnOptions })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, childConversationId));
  return childSpawnOptionsSchema.parse(row?.spawnOptions ?? {});
}
