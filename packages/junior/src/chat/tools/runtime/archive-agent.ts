import * as z from "zod";
import { setConversationArchive } from "@/api/conversations/archive";
import { AGENTS_TOOL_SOURCE } from "@/chat/child-agents/tool-source";
import { getConversationStore } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

const archiveAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Archived child conversation ID"),
  archived_at: z.string().describe("When the child agent was archived"),
});

export const archiveAgentToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: AGENTS_TOOL_SOURCE,
  description:
    "Archive a child agent that this conversation started, a Thread or a Task, for everyone, when its work is done. A person's new message restores it.",
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
          "Child conversation ID from startAgent or listAgents to archive",
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

/** Create the tool that archives one child agent of one conversation. */
export function createArchiveAgentTool(conversationId: string) {
  return zodTool({
    ...archiveAgentToolDefinition,
    execute: async (input) => {
      const childConversationId = input.conversation_id;
      const child = await getConversationStore().get({
        conversationId: childConversationId,
      });
      if (!child || child.parentConversationId !== conversationId) {
        throw new ToolInputError(
          `${childConversationId} is not a child agent of this conversation. Use listAgents to find its conversation_id.`,
        );
      }
      if (child.archivedAtMs !== undefined) {
        return {
          conversation_id: childConversationId,
          archived_at: new Date(child.archivedAtMs).toISOString(),
        };
      }
      // An open Turn, from a person or from this conversation, means the
      // child agent is in use.
      const working =
        child.execution.status === "pending" ||
        child.execution.status === "running" ||
        child.execution.status === "paused";
      if (working) {
        throw new ToolInputError(
          `${childConversationId} is working. Leave it, or wait until it is idle.`,
        );
      }
      const result = await setConversationArchive({
        applyToChildren: input.apply_to_children ?? false,
        archived: true,
        conversationId: childConversationId,
        // New activity after this read, such as a person's message, refuses
        // the archive.
        lastSeenAt: new Date(child.lastActivityAtMs).toISOString(),
      });
      switch (result.status) {
        case "archived":
          return {
            conversation_id: childConversationId,
            archived_at: result.archivedAt,
          };
        case "conflict":
          throw new ToolInputError(
            `${childConversationId} received new activity. Check it again with listAgents before you archive it.`,
          );
        case "unarchived_children":
          throw new ToolInputError(
            `${childConversationId} has ${result.unarchivedChildCount} child conversation(s) that are not archived. Pass apply_to_children to archive them too.`,
          );
        case "missing":
        case "archived_ancestor":
        case "restored":
          throw new Error(
            `Archive of child agent ${childConversationId} returned ${result.status}`,
          );
      }
    },
  });
}
