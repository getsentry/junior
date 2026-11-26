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
  description: `Send a message to your parent agent, one of your child agents, or any other agent that you can reach, such as a sibling. A private conversation reaches only agents in its own channel, DM, or private Space. Use it to give a child more work, an answer, or a correction, or to send a finding while you keep working. A message to a child continues its history. Any other agent runs it as data and sends you no result. A reply arrives later as new input; do not wait or poll for it. It does not end your task.`,
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
          `"${PARENT_AGENT_TARGET}" for your parent agent, the name or conversation_id of a child agent from startAgent or listAgents, or the conversation_id of any other agent that you can reach, such as one from listAgents, searchConversations, or slackThreadRead`,
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
 * another agent that the sender can reach.
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
