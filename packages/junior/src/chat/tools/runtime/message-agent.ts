import * as z from "zod";
import {
  ChildAgentLimitError,
  AgentMessageTargetError,
  AgentStoppedError,
} from "@/chat/child-agents/errors";
import { PARENT_AGENT_TARGET } from "@/chat/child-agents/types";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";

/** Bound the text of one message so a loop cannot fill a mailbox quickly. */
const MESSAGE_AGENT_TEXT_MAX_LENGTH = 8_000;

const messageAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z.string().min(1).describe("Target conversation ID"),
  delivery: z
    .enum(["started", "queued", "noted"])
    .describe(
      "started: the child agent starts work on the message now. queued: the target reads the message at its next step or after its current work. noted: this conversation is stopped, so the child agent got the message as a note that it sees when it next runs, and it started no work. Do not send it again.",
    ),
});

export const messageAgentToolDefinition = zodToolDefinition({
  description: `Send a message to your parent agent or to a child agent that this conversation started. Use it to give an existing child agent more work, an answer, or a correction, and to send your parent agent a finding or a question while you keep working. A message to a child continues its history. If the child is still working, it reads the message at its next step or after its current work. A child replies when it has something to report. Its reply arrives later as a new task in this conversation; do not wait or poll for it. Make sure people know what is going on, but post only updates that matter to them. A message to your parent does not end your task. A top-level agent (its conversation is not a child agent, such as a Slack thread) can also message another top-level agent. Both conversations must be public, or both must be private conversations in the same place, such as one private channel or DM. The target runs the message as its own task and sends no result. It does not start a new agent.`,
  exposure: "modelOnly",
  // A message to another Conversation can hand it work, so Guardian reviews
  // it (`review-by-default`). Messages to one agent keep their order.
  approvalMode: "auto",
  executionMode: "sequential",
  // Every agent that it can reach is part of this organization's work.
  describe: ({ to }) => ({ target: { ref: to, audience: "internal" } }),
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
          `"${PARENT_AGENT_TARGET}" for your parent agent, the name or conversation_id of a child agent from startAgent or listAgents, or the conversation_id of another top-level agent, such as one from listAgents or slackThreadRead`,
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
});

/**
 * Create the tool that sends one message to the parent, a child agent, or
 * another top-level agent.
 */
export function createMessageAgentTool(
  messageAgent: NonNullable<ToolRuntimeContext["messageAgent"]>,
) {
  return zodTool({
    ...messageAgentToolDefinition,
    execute: async (input, options) => {
      if (!options.toolCallId) {
        throw new ToolInputError(
          "messageAgent requires an active tool call ID. No change to the call can fix this.",
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
        if (error instanceof AgentStoppedError) {
          throw new ToolInputError(
            `${error.message}. Do not start more work. End this turn.`,
            { cause: error },
          );
        }
        if (error instanceof ChildAgentLimitError) {
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
