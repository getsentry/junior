import { z } from "zod";
import {
  AgentInvocationBusyError,
  AgentInvocationLimitError,
} from "@/chat/agent-invocations/errors";
import { agentNameSchema } from "@/chat/agent-invocations/types";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const SPAWN_AGENT_TOOL_NAME = "spawnAgent";

const spawnAgentOutputSchema = juniorToolOutputSchema.extend({
  invocation_id: z.string().min(1),
});

/** Create the asynchronous child-agent tool for one parent run. */
export function createSpawnAgentTool(
  spawnAgent: NonNullable<ToolRuntimeContext["spawnAgent"]>,
) {
  return zodTool({
    description:
      "Start an asynchronous child agent on a delegated task. Give it a name to reuse the same child agent and its history on later calls; omit the name for a one-off agent. This call confirms durable scheduling, not task completion.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        task: z.string().trim().min(1).describe("Task for the child agent"),
        name: agentNameSchema
          .nullable()
          .optional()
          .describe("Stable child-agent name, or omit for a one-off agent"),
        reasoning_level: z
          .enum(TURN_REASONING_LEVELS)
          .nullable()
          .optional()
          .describe(
            "Optional reasoning level for this delegated task only",
          ),
      })
      .strict(),
    outputSchema: spawnAgentOutputSchema,
    execute: async (input, options) => {
      if (!options.toolCallId) {
        throw new ToolInputError("spawnAgent requires an active tool call ID");
      }
      let result;
      try {
        result = await spawnAgent(
          {
            task: input.task,
            ...(input.name ? { name: input.name } : {}),
            ...(input.reasoning_level
              ? { reasoningLevel: input.reasoning_level }
              : {}),
          },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            toolCallId: options.toolCallId,
          },
        );
      } catch (error) {
        if (error instanceof AgentInvocationBusyError) {
          throw new ToolInputError(
            `${error.message}. Wait for it to finish or use a different name.`,
            { cause: error },
          );
        }
        if (error instanceof AgentInvocationLimitError) {
          throw new ToolInputError(
            `${error.message}. Wait for active children to finish before spawning more.`,
            { cause: error },
          );
        }
        throw error;
      }
      return {
        invocation_id: result.invocationId,
      };
    },
  });
}
