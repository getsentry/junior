import { z } from "zod";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
} from "@/chat/agent-invocations/errors";
import {
  agentNameSchema,
  PARENT_AGENT_TARGET,
} from "@/chat/agent-invocations/types";
import { completeText } from "@/chat/pi/client";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import {
  formatModelProfiles,
  type ModelProfile,
} from "@/chat/model-profile";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type {
  SpawnAgentProfileControl,
  ToolRuntimeContext,
} from "@/chat/tools/types";

export const SPAWN_AGENT_TOOL_NAME = "spawnAgent";

const spawnAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z
    .string()
    .min(1)
    .describe(
      "Child conversation ID. Pass it to searchConversationEvents to read the child's history.",
    ),
});

/** Create the asynchronous child-agent tool for one parent run. */
export function createSpawnAgentTool(
  spawnAgent: NonNullable<ToolRuntimeContext["spawnAgent"]>,
  profileControl: SpawnAgentProfileControl,
) {
  const profileNames = [
    profileControl.defaultProfile,
    ...Object.keys(profileControl.profiles)
      .filter((profile) => profile !== profileControl.defaultProfile)
      .sort(),
  ] as [ModelProfile, ...ModelProfile[]];
  const profileSchema = z.enum(profileNames);
  const profileList = formatModelProfiles(profileControl.profiles, profileNames);
  return zodTool({
    description: [
      "Start a new asynchronous child agent on a delegated task. Give it a name when you may send it more work later. To give more work to a child agent that already exists, use messageAgent instead.",
      "The parent should normally choose the child's profile to fit the delegated task. Use the profile descriptions below to choose; do not choose by profile name alone. When omitted, the child uses the profile active for this turn. A child keeps its original profile when it receives more work through messageAgent.",
      "This call confirms durable scheduling, not task completion. The result arrives later as a new task in this conversation; do not wait or poll for it.",
      `Configured profiles:\n${profileList}`,
    ].join(" "),
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        task: z.string().trim().min(1).describe("Task for the child agent"),
        title: z
          .string()
          .trim()
          .min(1)
          .max(SHORT_TITLE_MAX_LENGTH)
          .nullable()
          .optional()
          .describe(
            "Optional short display title for the task. Omit to generate one from the task.",
          ),
        name: agentNameSchema
          .refine((name) => name !== PARENT_AGENT_TARGET, {
            message: `"${PARENT_AGENT_TARGET}" is reserved`,
          })
          .nullable()
          .optional()
          .describe(
            "New child-agent name that messageAgent can address, or omit for a one-off agent",
          ),
        profile: profileSchema
          .optional()
          .describe(
            "Exact configured profile whose task-fit description matches the delegated task. The parent should normally set this; omit to use the active profile for this turn.",
          ),
        reasoning_level: z
          .enum(TURN_REASONING_LEVELS)
          .nullable()
          .optional()
          .describe("Optional reasoning level for this delegated task only"),
      })
      .strict(),
    outputSchema: spawnAgentOutputSchema,
    execute: async (input, options) => {
      if (!options.toolCallId) {
        throw new ToolInputError("spawnAgent requires an active tool call ID");
      }
      const title = await resolveTaskTitle({
        completeText,
        instruction: input.task,
        signal: options.signal,
        title: input.title,
      });
      let result;
      try {
        result = await spawnAgent(
          {
            task: input.task,
            profile: input.profile ?? profileControl.activeProfile(),
            ...(title ? { title } : undefined),
            ...(input.name ? { name: input.name } : undefined),
            ...(input.reasoning_level
              ? { reasoningLevel: input.reasoning_level }
              : undefined),
          },
          {
            ...(options.signal ? { signal: options.signal } : undefined),
            toolCallId: options.toolCallId,
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
            `${error.message}. Wait for active children to finish before spawning more.`,
            { cause: error },
          );
        }
        throw error;
      }
      return {
        conversation_id: result.childConversationId,
      };
    },
  });
}
