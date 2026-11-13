import * as z from "zod";
import { setConversationArchive } from "@/api/conversations/archive";
import { readLastUserMessageAtByConversation } from "@/api/conversations/user-message-activity";
import {
  getLatestAgentInvocationForConversation,
  listOpenAgentInvocations,
} from "@/chat/agent-invocations/store";
import { readLastParentMessageAtMs } from "@/chat/agent-invocations/parent-message";
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
      "Archive a Thread that this conversation started, for everyone. A person's new message restores it. A result from a Thread does not mean that people are done with it: people message Threads directly, and you do not see those messages. The archive fails when a person messaged the Thread since you last gave it work: that person decides, and can archive it from its dashboard_url.",
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
            "Thread conversation ID from spawnAgent or listAgents to archive",
          ),
        apply_to_children: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "True also archives the child agents that the Thread started, at any depth. Without it, the archive fails while any of them is not archived.",
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
          `${childConversationId} is not a child agent of this conversation. Use listAgents to find its conversation_id.`,
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
      // A person who messaged the Thread since this conversation last gave
      // it work took it over, so only people archive it from then on. The
      // invocation's creation time never moves; its update time does, for
      // example when its result reaches the parent's mailbox.
      const personMessageAt =
        await readLastPersonMessageAtMs(childConversationId);
      // A child that no Agent invocation names got its work as parent
      // messages.
      const latest =
        await getLatestAgentInvocationForConversation(childConversationId);
      const lastWorkAt = latest
        ? latest.createdAtMs
        : await readLastParentMessageAtMs(childConversationId);
      if (
        personMessageAt !== undefined &&
        personMessageAt > (lastWorkAt ?? 0)
      ) {
        throw new ToolInputError(
          `A person messaged ${childConversationId} since you last gave it work, so a person still uses it. Leave it. That person can archive it from its dashboard_url.`,
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
            `Archive of Thread ${childConversationId} returned ${result.status}`,
          );
      }
    },
  });
}
