import * as z from "zod";
import {
  AgentDepthLimitError,
  AgentInvocationLimitError,
  AgentNameInUseError,
  AgentStoppedError,
} from "@/chat/agent-invocations/errors";
import {
  agentNameSchema,
  CHILD_AGENT_KINDS,
  PARENT_AGENT_TARGET,
} from "@/chat/agent-invocations/types";
import {
  AGENT_TYPES,
  formatAgentTypes,
} from "@/chat/agent-invocations/agent-types";
import {
  startedAgentSchema,
  startedAgentTitleSchema,
} from "@/chat/agent-invocations/started-agent";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { completeText, type ConversationModelCost } from "@/chat/core-model";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { resolveTaskTitle } from "@/chat/services/short-title";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";

const childInputSchema = z
  .object({
    task: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Self-contained brief: the goal, targets, verified facts, constraints and allowed side effects, what done means, and the result shape. Unless fork is true, it is the child's only context.",
      ),
    title: startedAgentTitleSchema
      .nullable()
      .optional()
      .describe("Short display title. Omit it to generate one from the task."),
    name: agentNameSchema
      .refine((name) => name !== PARENT_AGENT_TARGET, {
        message: `"${PARENT_AGENT_TARGET}" is reserved`,
      })
      .nullable()
      .optional()
      .describe(
        "Name that messageAgent can address later. Omit it for a one-off agent.",
      ),
    kind: z
      .enum(CHILD_AGENT_KINDS)
      .nullable()
      .optional()
      .describe(
        "thread: one work item, about one issue or code change, that people open, message, and steer. A request for a thread means this, not a Slack thread. task (default): background work that only you message.",
      ),
    agent_type: z
      .enum(AGENT_TYPES)
      .nullable()
      .optional()
      .describe(
        `Child agent type. ${formatAgentTypes()} Omit it for a general child.`,
      ),
    fork: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "true: the child starts with a copy of this conversation's history, which adds cost and noise. Use it only when a brief would repeat most of this conversation. Then the task says only what to do and what is in scope.",
      ),
    reasoning_level: z
      .enum(TURN_REASONING_LEVELS)
      .nullable()
      .optional()
      .describe("Reasoning level of the child. Omit it to use the default."),
  })
  .strict();

/** Static definition of `startAgent` in a Turn that starts child agents. */
export const startAgentToolDefinition = zodToolDefinition({
  description:
    "Start an asynchronous child agent with its own conversation, sandbox, and tool budget. It runs at the same time as you, and its result arrives in a later turn. A Thread is one work item that people own and message. A Task is background work that only you message. To give more work to an agent that already exists, use messageAgent instead.",
  exposure: "modelOnly",
  // Action review judges the actions that the task names.
  approvalMode: "auto",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: childInputSchema,
  outputSchema: startedAgentSchema,
});

/** Create the `startAgent` tool that starts child agents of one Turn. */
export function createStartAgentTool(
  spawnAgent: NonNullable<ToolRuntimeContext["spawnAgent"]>,
  titleCost: ConversationModelCost,
) {
  return zodTool({
    ...startAgentToolDefinition,
    execute: async (input, options) => {
      const { toolCallId } = options;
      if (!toolCallId) {
        throw new ToolInputError(
          "startAgent requires an active tool call ID. No change to the call can fix this.",
        );
      }
      const title = await resolveTaskTitle({
        completeText,
        cost: titleCost,
        instruction: input.task,
        signal: options.signal,
        title: input.title,
      });
      let result;
      try {
        result = await spawnAgent(
          {
            task: input.task,
            ...(input.agent_type ? { agentType: input.agent_type } : undefined),
            ...(input.fork ? { fork: true } : undefined),
            ...(input.kind ? { kind: input.kind } : undefined),
            ...(title ? { title } : undefined),
            ...(input.name ? { name: input.name } : undefined),
            ...(input.reasoning_level
              ? { reasoningLevel: input.reasoning_level }
              : undefined),
          },
          {
            ...(options.signal ? { signal: options.signal } : undefined),
            toolCallId,
          },
        );
      } catch (error) {
        if (error instanceof AgentNameInUseError) {
          throw new ToolInputError(
            `${error.message}. Use messageAgent to give it more work, or choose a different name.`,
            { cause: error },
          );
        }
        if (error instanceof AgentInvocationLimitError) {
          throw new ToolInputError(
            `${error.message}. Wait for active children to finish before you start more.`,
            { cause: error },
          );
        }
        if (error instanceof AgentStoppedError) {
          throw new ToolInputError(
            `${error.message}. Do not start more work. End this turn.`,
            { cause: error },
          );
        }
        if (error instanceof AgentDepthLimitError) {
          throw new ToolInputError(
            `${error.message}. Do the work in this agent instead.`,
            { cause: error },
          );
        }
        throw error;
      }
      const url = getDashboardConversationLink(result.childConversationId);
      return {
        conversation_id: result.childConversationId,
        ...(url ? { url } : undefined),
      };
    },
  });
}
