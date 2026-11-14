import * as z from "zod";
import {
  AgentInvocationLimitError,
  AgentMessagePausedError,
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

// A channel Thread's final responses go to its channel. The parent sees
// only what this tool sends, so the Thread decides what the parent must know.
const CHANNEL_THREAD_PARENT_STEERING =
  "You work with people in your own channel, and your responses go there. Your parent agent sees none of it: this tool is the only way to reach it. Message your parent when it needs to know or act: you finished the work it gave you, you need a decision or access only it has, or you are blocked. Keep it short and include links. Do not send it each update that you post in your channel. When your channel is archived, the runtime sends your parent one wrap-up.";

/**
 * Create the tool that sends one message to the parent, a child agent, or
 * another top-level agent.
 */
export function createMessageAgentTool(
  messageAgent: NonNullable<ToolRuntimeContext["messageAgent"]>,
  variant?: "channel_thread",
) {
  return zodTool({
    description: `${variant === "channel_thread" ? `${CHANNEL_THREAD_PARENT_STEERING} ` : ""}Send a message to your parent agent or to a child agent that this conversation started. Use it to give an existing child agent more work, an answer, or a correction, and to send your parent agent a finding or a question while you keep working. A message to a child continues its history. If the child is still working, it reads the message at its next step or after its current work. A child replies when it has something to report. Its reply arrives later as a new task in this conversation; do not wait or poll for it. Make sure people know what is going on, but post only updates that matter to them. A message to your parent does not end your task. A top-level agent (its conversation is not a child agent, such as a Slack thread) can also message another top-level agent. Both conversations must be public, or both must be private conversations in the same place, such as one private channel or DM. The target runs the message as its own task and sends no result. Use spawnAgent only to start a new child agent.`,
    exposure: "modelOnly",
    // Action review judges the actions that the message names.
    approvalMode: "auto",
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
            `"${PARENT_AGENT_TARGET}" for your parent agent, the name or conversation_id of a child agent from spawnAgent or listAgents, or the conversation_id of another top-level agent, such as one from searchConversations or slackThreadRead`,
          ),
        text: z
          .string()
          .trim()
          .min(1)
          .max(MESSAGE_AGENT_TEXT_MAX_LENGTH)
          .describe(
            "Message text. Include all context the target needs. Text to a child agent is its instruction. Its action review judges the child's actions against that text, so name only actions that your own conversation backs, with the exact target.",
          ),
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
            `${error.message}. Use listAgents to find an agent.`,
            { cause: error },
          );
        }
        if (error instanceof AgentMessagePausedError) {
          throw new ToolInputError(
            `${error.message}. Do not send it more messages. Tell the user instead.`,
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
