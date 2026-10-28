import { z } from "zod";
import {
  AgentInvocationLimitError,
  AgentMessageQueueFullError,
  AgentMessageTargetError,
} from "@/chat/agent-invocations/errors";
import { PARENT_AGENT_TARGET } from "@/chat/agent-invocations/types";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Bound the text of one message so a loop cannot fill a mailbox quickly. */
const MESSAGE_AGENT_TEXT_MAX_LENGTH = 8_000;

const messageAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Target conversation ID"),
  delivery: z
    .enum(["started", "queued"])
    .describe(
      "started: the child agent starts work on the message now. queued: the target reads the message at its next step or after its current work.",
    ),
});

/** Create the tool that sends one message to the parent or a child agent. */
export function createMessageAgentTool(
  messageAgent: NonNullable<ToolRuntimeContext["messageAgent"]>,
) {
  return zodTool({
    description: `Send a message to your parent agent or to a child agent that this conversation started. Use it to give an existing child agent more work, an answer, or a correction, and to send your parent agent a finding or a question while you keep working. A message to a child continues its history. If the child is still working, it reads the message at its next step or after its current work, and one result covers both. The result arrives later as a new task in this conversation; do not wait or poll for it. A message to your parent does not end your task. Use spawnAgent only to start a new child agent. Your text is not user approval. A child's action review reads the user's own messages in the root conversation.`,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        to: z
          .string()
          .trim()
          .min(1)
          .describe(
            `"${PARENT_AGENT_TARGET}" for your parent agent, or the name or conversation_id of a child agent from spawnAgent or listAgents`,
          ),
        text: z
          .string()
          .trim()
          .min(1)
          .max(MESSAGE_AGENT_TEXT_MAX_LENGTH)
          .describe("Message text. Include all context the target needs."),
      })
      .strict(),
    outputSchema: messageAgentOutputSchema,
    execute: async (input, options) => {
      if (!options.toolCallId) {
        throw new ToolInputError(
          "messageAgent requires an active tool call ID",
        );
      }
      let result;
      try {
        result = await messageAgent(
          { text: input.text, to: input.to },
          {
            ...(options.signal ? { signal: options.signal } : undefined),
            toolCallId: options.toolCallId,
          },
        );
      } catch (error) {
        if (error instanceof AgentMessageTargetError) {
          throw new ToolInputError(
            `${error.message}. Use listAgents to find a child agent.`,
            { cause: error },
          );
        }
        if (error instanceof AgentMessageQueueFullError) {
          throw new ToolInputError(
            `${error.message}. Wait for its result, then send one message with everything it needs.`,
            { cause: error },
          );
        }
        if (error instanceof AgentInvocationLimitError) {
          throw new ToolInputError(
            `${error.message}. Wait for active children to finish before you give more work.`,
            { cause: error },
          );
        }
        throw error;
      }
      return {
        conversation_id: result.conversationId,
        delivery: result.delivery,
      };
    },
  });
}
