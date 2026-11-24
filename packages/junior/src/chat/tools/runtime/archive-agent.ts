import * as z from "zod";
import { setConversationArchive } from "@/api/conversations/archive";
import { readLastUserMessageAtByConversation } from "@/api/conversations/user-message-activity";
import { readLastParentMessageAtMs } from "@/chat/agent-invocations/parent-message";
import { AGENTS_TOOL_SOURCE } from "@/chat/agent-invocations/tool-source";
import {
  conversationDescendants,
  readConversationTrees,
} from "@/chat/conversations/sql/conversation-tree";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";

const archiveAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Archived child conversation ID"),
  archived_at: z.string().describe("When the child agent was archived"),
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
    "Archive a child agent that this conversation started, a Thread or a Task, for everyone, when its work is done. A person's new message restores it. A result from a Thread does not mean that people are done with it: people message Threads directly, and you do not see those messages. The archive fails when a person messaged the child since you last gave it work: that person decides, and can archive it from its url.",
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

// A person who messaged an agent since its parent last gave it work took it
// over, so only people archive it from then on.
async function requireNoPersonUse(conversationId: string): Promise<void> {
  const [personMessageAt, lastWorkAt] = await Promise.all([
    readLastPersonMessageAtMs(conversationId),
    readLastParentMessageAtMs(conversationId),
  ]);
  if (personMessageAt !== undefined && personMessageAt > (lastWorkAt ?? 0)) {
    throw new ToolInputError(
      `A person messaged ${conversationId} since its parent last gave it work, so a person still uses it. Leave it. That person can archive it from its url.`,
    );
  }
}

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
      // `apply_to_children` also archives the child agents below it, so
      // none of them may be in a person's use either.
      const descendants = input.apply_to_children
        ? conversationDescendants(
            await readConversationTrees(getDb(), [
              child.rootConversationId ?? childConversationId,
            ]),
            childConversationId,
          ).filter((node) => !node.archivedAt)
        : [];
      await Promise.all(
        [
          childConversationId,
          ...descendants.map((node) => node.conversationId),
        ].map(requireNoPersonUse),
      );
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
