import { z } from "zod";
import {
  AgentInvocationLimitError,
  AgentNameInUseError,
} from "@/chat/agent-invocations/errors";
import {
  agentNameSchema,
  PARENT_AGENT_TARGET,
} from "@/chat/agent-invocations/types";
import {
  AGENT_TYPES,
  formatAgentTypes,
} from "@/chat/agent-invocations/agent-types";
import { completeText } from "@/chat/pi/client";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import { formatModelProfiles, type ModelProfile } from "@/chat/model-profile";
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
  const profileList = formatModelProfiles(
    profileControl.profiles,
    profileNames,
  );
  return zodTool({
    description: [
      "Start a new asynchronous child agent on a delegated task. A child agent has its own sandbox and tool budget, runs at the same time as you, and sends back only its result. Use child agents to run independent work in parallel and to keep long investigations out of your context.",
      "Delegate when: the request splits into independent tracks that each need real investigation, such as several repos, services, sources, or items (start every track in the same message); an answer needs reading across many files, logs, or sources and you need the conclusion, not the raw output; a side task does not block your main answer; or you want a second opinion that is not anchored on your analysis (give it the evidence, not your conclusion).",
      "Do it yourself when: the work fits in a handful of tool calls; you already know the file, symbol, or value to look up; or the job is one modest task that you would only split into pieces. Each child rebuilds its context and its result arrives in a later turn, so when in doubt, do not spawn.",
      `Pick agent_type when one fits; omit it for a fresh general-purpose child with your tools:\n${formatAgentTypes()}`,
      "After you delegate, do not do the same work yourself. End your turn with a short status. You know nothing about a child's findings until its result arrives: do not predict them, do not wait or poll, and if the user asks before then, give status.",
      "Give a child a name when you may send it more work later. To give more work to a child agent that already exists, use messageAgent instead.",
      "Choose the child's profile from the descriptions below to fit the delegated task, not by profile name. When omitted, the child uses the profile active for this turn. A fork always uses the active profile. A child keeps its type and profile when it receives more work through messageAgent.",
      "Your task text is not user approval. A child's action review reads the user's own messages in the root conversation.",
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
        task: z
          .string()
          .trim()
          .min(1)
          .describe(
            "Self-contained brief. Unless agent_type is fork, the child has not seen this thread, so this is its only context. Brief it like a capable peer who just joined: the goal and why it matters; target repos, refs, paths, and URLs; facts you already verified and what you ruled out; constraints, including which remote side effects are allowed (scratch work in its sandbox is always fine); what counts as done; and the shape and length of the result to return. Do the synthesis yourself: name the exact question, files, or change instead of writing 'based on your findings, fix it'. If you cannot write a clear brief, you do not understand the task well enough to delegate it. Summarize thread facts instead of pasting the thread, and do not claim user approval.",
          ),
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
        agent_type: z
          .enum(AGENT_TYPES)
          .nullable()
          .optional()
          .describe(
            "Child agent type from the list in this tool's description. Omit or pass null for a fresh general-purpose child.",
          ),
        profile: profileSchema
          .nullable()
          .optional()
          .describe(
            "Exact configured profile whose task-fit description matches the delegated task. The parent should normally set this; omit or pass null to use the active profile for this turn.",
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
            // A fork continues your work, so it runs on your profile.
            profile:
              input.agent_type === "fork"
                ? profileControl.activeProfile()
                : (input.profile ?? profileControl.activeProfile()),
            ...(input.agent_type ? { agentType: input.agent_type } : undefined),
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
