import * as z from "zod";
import { setConversationArchive } from "@/api/conversations/archive";
import { readLastUserMessageAtByConversation } from "@/api/conversations/user-message-activity";
import {
  getLatestAgentInvocationForConversation,
  listOpenAgentInvocations,
} from "@/chat/agent-invocations/store";
import { AGENTS_TOOL_SOURCE } from "@/chat/agent-invocations/tool-source";
import { getConversationStore, getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

export const ARCHIVE_AGENT_TOOL_NAME = "archiveAgent";

const archiveAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Archived Thread ID"),
  archived_at: z.string().describe("When the Thread was archived"),
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

/** Create the tool that archives one Thread that a conversation started. */
export function createArchiveAgentTool(conversationId: string) {
  return zodTool({
    exposure: "deferred",
    source: AGENTS_TOOL_SOURCE,
    description:
      "Archive a Thread that this conversation started, for everyone. An archived Thread no longer counts toward your limit of active children, and a person's new message restores it. A result from a Thread does not mean that people are done with it: people message Threads directly, and you do not see those messages. The archive fails when a person messaged the Thread after its last result: leave that Thread, unless that person asked you to archive it.",
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
            "Thread conversation ID from spawnAgent or searchAgents to archive",
          ),
        apply_to_children: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "True also archives the child agents that the Thread started, at any depth. Without it, the archive fails while any of them is not archived.",
          ),
        person_asked: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "True only when the person who messaged the Thread asked you to archive it.",
          ),
      })
      .strict(),
    outputSchema: archiveAgentOutputSchema,
    execute: async (input) => {
      const childConversationId = input.conversation_id;
      const child = await getConversationStore().get({
        conversationId: childConversationId,
      });
      if (!child || child.parentConversationId !== conversationId) {
        throw new ToolInputError(
          `${childConversationId} is not a child agent of this conversation. Use searchAgents to find its conversation_id.`,
        );
      }
      if (child.kind !== "thread") {
        throw new ToolInputError(
          `${childConversationId} is a Task. Only a Thread can be archived. A Task needs no archive.`,
        );
      }
      if (child.archivedAtMs !== undefined) {
        return {
          conversation_id: childConversationId,
          archived_at: new Date(child.archivedAtMs).toISOString(),
        };
      }
      // An open Turn, from a person or from this conversation, means the
      // Thread is in use.
      const working =
        child.execution.status === "pending" ||
        child.execution.status === "running" ||
        child.execution.status === "paused" ||
        (await listOpenAgentInvocations(childConversationId)).some(
          (row) => row.childConversationId === childConversationId,
        );
      if (working) {
        throw new ToolInputError(
          `${childConversationId} is working. Leave it, or wait until it is idle.`,
        );
      }
      if (!input.person_asked) {
        const personMessageAt =
          await readLastPersonMessageAtMs(childConversationId);
        const latest =
          await getLatestAgentInvocationForConversation(childConversationId);
        if (
          personMessageAt !== undefined &&
          personMessageAt > (latest?.updatedAtMs ?? 0)
        ) {
          throw new ToolInputError(
            `A person messaged ${childConversationId} after its last result, so a person still uses it. Leave it, unless that person asked you to archive it.`,
          );
        }
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
            `${childConversationId} received new activity. Check it again with searchAgents before you archive it.`,
          );
        case "unarchived_children":
          throw new ToolInputError(
            `${childConversationId} has ${result.unarchivedChildCount} child conversation(s) that are not archived. Pass apply_to_children to archive them too.`,
          );
        case "missing":
        case "archived_ancestor":
        case "restored":
          throw new Error(
            `Archive of Thread ${childConversationId} returned ${result.status}`,
          );
      }
    },
  });
}
