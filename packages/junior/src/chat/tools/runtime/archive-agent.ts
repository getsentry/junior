import * as z from "zod";
import { setConversationArchive } from "@/api/conversations/archive";
import { readLastUserMessageAtByConversation } from "@/api/conversations/user-message-activity";
import { readLastParentMessageAtMs } from "@/chat/agent-invocations/parent-message";
import { isLeadTeamRoot } from "@/chat/agent-invocations/team";
import { AGENTS_TOOL_SOURCE } from "@/chat/agent-invocations/tool-source";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

const archiveAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Archived conversation ID"),
  archived_at: z.string().describe("When the conversation was archived"),
});

/** Read when a person last sent a Message to one Conversation. */
async function readLastPersonMessageAtMs(
  conversationId: string,
): Promise<number | undefined> {
  const at = (
    await readLastUserMessageAtByConversation(getDb(), [conversationId])
  ).get(conversationId);
  return at === undefined ? undefined : Date.parse(at);
}

export const archiveAgentToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: AGENTS_TOOL_SOURCE,
  description:
    "Archive an agent on your team, for everyone, when its work is done. A person's new message restores it. A result does not mean that people are done with it: people message a Thread or a root directly, and you do not see those messages. A child agent's archive fails when a person messaged it since you last gave it work: that person decides, and can archive it from its url.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      conversation_id: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Conversation ID from startAgent or listAgents of the agent to archive",
        ),
      apply_to_children: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "True also archives the child agents that it started, at any depth. Without it, the archive fails while any of them is not archived.",
        ),
    })
    .strict(),
  outputSchema: archiveAgentOutputSchema,
});

/**
 * Create the tool that archives one agent on the team of one conversation:
 * a child agent of any kind, or for a Lead, a root of its person.
 */
export function createArchiveAgentTool(conversationId: string) {
  return zodTool({
    ...archiveAgentToolDefinition,
    execute: async (input) => {
      const agentConversationId = input.conversation_id;
      const agent = await getConversationStore().get({
        conversationId: agentConversationId,
      });
      const isChild = agent?.parentConversationId === conversationId;
      if (
        !agent ||
        (!isChild &&
          !(await isLeadTeamRoot({
            conversationId: agentConversationId,
            leadConversationId: conversationId,
          })))
      ) {
        throw new ToolInputError(
          `${agentConversationId} is not an agent on your team. Use listAgents to find its conversation_id.`,
        );
      }
      if (agent.archivedAtMs !== undefined) {
        return {
          conversation_id: agentConversationId,
          archived_at: new Date(agent.archivedAtMs).toISOString(),
        };
      }
      // An open Turn, from a person or from this conversation, means the
      // agent is in use.
      const working =
        agent.execution.status === "pending" ||
        agent.execution.status === "running" ||
        agent.execution.status === "paused";
      if (working) {
        throw new ToolInputError(
          `${agentConversationId} is working. Leave it, or wait until it is idle.`,
        );
      }
      // A person who messaged a child agent since its parent last gave it
      // work took it over, so only people archive it from then on. A Lead
      // archives a root as its person could.
      if (isChild) {
        const personMessageAt =
          await readLastPersonMessageAtMs(agentConversationId);
        const lastWorkAt = await readLastParentMessageAtMs(agentConversationId);
        if (
          personMessageAt !== undefined &&
          personMessageAt > (lastWorkAt ?? 0)
        ) {
          throw new ToolInputError(
            `A person messaged ${agentConversationId} since you last gave it work, so a person still uses it. Leave it. That person can archive it from its url.`,
          );
        }
      }
      const result = await setConversationArchive({
        applyToChildren: input.apply_to_children ?? false,
        archived: true,
        conversationId: agentConversationId,
        // New activity after this read, such as a person's message, refuses
        // the archive.
        lastSeenAt: new Date(agent.lastActivityAtMs).toISOString(),
      });
      switch (result.status) {
        case "archived":
          return {
            conversation_id: agentConversationId,
            archived_at: result.archivedAt,
          };
        case "conflict":
          throw new ToolInputError(
            `${agentConversationId} received new activity. Check it again with listAgents before you archive it.`,
          );
        case "unarchived_children":
          throw new ToolInputError(
            `${agentConversationId} has ${result.unarchivedChildCount} child conversation(s) that are not archived. Pass apply_to_children to archive them too.`,
          );
        case "missing":
        case "archived_ancestor":
        case "restored":
          throw new Error(
            `Archive of agent ${agentConversationId} returned ${result.status}`,
          );
      }
    },
  });
}
