import * as z from "zod";
import { stopChildAgent } from "@/chat/agent-invocations/stop";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { isLeadTeamRoot } from "@/chat/agent-invocations/team";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { AGENTS_TOOL_SOURCE } from "@/chat/agent-invocations/tool-source";

const stopAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Stopped conversation ID"),
  stopped: z
    .boolean()
    .describe(
      "True when work was stopped. False when the agent had already stopped.",
    ),
});

export const stopAgentToolDefinition = zodToolDefinition({
  exposure: "deferred",
  source: AGENTS_TOOL_SOURCE,
  description:
    "Stop an agent on your team, and every child agent that it started. Use it when its work is no longer needed or goes in the wrong direction. A stopped agent sends no result. To give it new work later, use messageAgent.",
  annotations: {
    destructiveHint: true,
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
          "Conversation ID from startAgent or listAgents of the agent to stop",
        ),
    })
    .strict(),
  outputSchema: stopAgentOutputSchema,
});

/**
 * Create the tool that stops one agent on the team of one conversation: a
 * child agent, or for a Lead, a root of its person.
 */
export function createStopAgentTool(
  conversationId: string,
  options: {
    /** A Lead stops the roots of its person. */
    lead?: boolean;
    queue?: ConversationWorkQueue | undefined;
  } = {},
) {
  return zodTool({
    ...stopAgentToolDefinition,
    execute: async (input) => {
      const stopped = options.lead
        ? await stopLeadRoot({
            conversationId: input.conversation_id,
            leadConversationId: conversationId,
            queue: options.queue ?? getVercelConversationWorkQueue(),
          })
        : await stopChildAgent({
            childConversationId: input.conversation_id,
            parentConversationId: conversationId,
          });
      if (!stopped) {
        throw new ToolInputError(
          `${input.conversation_id} is not an agent on your team. Use listAgents to find its conversation_id.`,
        );
      }
      return {
        conversation_id: input.conversation_id,
        stopped: stopped.stopped,
      };
    },
  });
}

// A Lead stops a root for its person, the same as the person's own stop.
async function stopLeadRoot(args: {
  conversationId: string;
  leadConversationId: string;
  queue: ConversationWorkQueue;
}): Promise<{ stopped: boolean } | undefined> {
  if (
    !(await isLeadTeamRoot({
      conversationId: args.conversationId,
      leadConversationId: args.leadConversationId,
    }))
  ) {
    return undefined;
  }
  const wasStopped =
    (await getConversationStoppedAtMs(args.conversationId)) !== undefined;
  await stopConversation({
    conversationId: args.conversationId,
    queue: args.queue,
  });
  return { stopped: !wasStopped };
}
