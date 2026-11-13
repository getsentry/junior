import * as z from "zod";
import {
  AgentDepthLimitError,
  AgentInvocationLimitError,
  AgentNameInUseError,
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
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { completeText, type ConversationModelCost } from "@/chat/core-model";
import { TURN_REASONING_LEVELS } from "@/chat/reasoning-level";
import {
  resolveTaskTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

export const SPAWN_AGENT_TOOL_NAME = "spawnAgent";

const spawnAgentOutputSchema = juniorToolOutputSchema.extend({
  conversation_id: z
    .string()
    .min(1)
    .describe(
      "Child conversation ID. Pass it to searchConversationEvents to read the child's history.",
    ),
  dashboard_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Dashboard link of the child. People can message a Thread there.",
    ),
});

/** Create the asynchronous child-agent tool for one parent run. */
export function createSpawnAgentTool(
  spawnAgent: NonNullable<ToolRuntimeContext["spawnAgent"]>,
  titleCost: ConversationModelCost,
) {
  return zodTool({
    description: [
      "Start a new asynchronous child agent. A child agent has its own sandbox and tool budget, runs at the same time as you, and replies when it has something to report. Its kind is a Thread for one discrete work item that people will own and talk to, or a Task for work that you delegate. Use Tasks to run independent work in parallel and to keep long investigations out of your context.",
      "Delegate a Task when: the request splits into independent tracks that each need real investigation, such as several repos, services, sources, or items (start every track in the same message); an answer needs reading across many files, logs, or sources and you need the conclusion, not the raw output; a side task does not block your main answer; or you want a second opinion that is not anchored on your analysis (give it the evidence, not your conclusion).",
      "Do it yourself instead of a Task when: the work fits in a handful of tool calls; you already know the file, symbol, or value to look up; or the job is one modest task that you would only split into pieces. Each child rebuilds its context and its result arrives in a later turn, so when in doubt, do not spawn a Task.",
      `Child agent types:\n${formatAgentTypes()}`,
      "After you delegate, do not do the same work yourself. Make sure people know what is going on, but post only updates that matter to them. Share a Thread's dashboard_url so people can find it.",
      "You know nothing about a child's findings until its result arrives: do not predict them, do not wait or poll, and if the user asks before then, give status.",
      "Give a child a name when you may send it more work later. To give more work to a child agent that already exists, use messageAgent instead.",
      "A child keeps its type and kind when it receives more work through messageAgent.",
      "Your task text is the child's instruction. Its action review judges the child's actions against that text, so name only actions that your own conversation backs, with the exact target.",
    ].join(" "),
    exposure: "modelOnly",
    // Action review judges the actions that the task names.
    approvalMode: "auto",
    describeProgress: () => "Starting a child agent",
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
            "Self-contained brief. Unless fork is true, the child has not seen this thread, so this is its only context. Brief it like a capable peer who just joined: the goal and why it matters; target repos, refs, paths, and URLs; facts you already verified and what you ruled out; constraints, including which remote side effects are allowed (scratch work in its sandbox is always fine); what counts as done; and the shape and length of the result to return. Do the synthesis yourself: name the exact question, files, or change instead of writing 'based on your findings, fix it'. If you cannot write a clear brief, you do not understand the task well enough to delegate it. Summarize thread facts instead of pasting the thread. When fork is true, the task is a directive: say what to do and what is in or out of scope; do not re-explain the background.",
          ),
        title: z
          .string()
          .trim()
          .min(1)
          .max(SHORT_TITLE_MAX_LENGTH)
          .nullable()
          .optional()
          .describe(
            "Optional short display title of the child and its Conversation. Pass one to skip title generation; omit it to generate one from the task.",
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
        kind: z
          .enum(CHILD_AGENT_KINDS)
          .nullable()
          .optional()
          .describe(
            "thread: one work item about the size of one issue or code change, or long-lived work, that people open, message, follow, and steer. A request to create or start a thread means this kind, not a Slack thread. task (default): background work only you message.",
          ),
        agent_type: z
          .enum(AGENT_TYPES)
          .nullable()
          .optional()
          .describe(
            "Child agent type from the list in this tool's description. Pick one when it fits. Omit or pass null for a general-purpose child with your tools.",
          ),
        fork: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "true: the child gets a copy of this conversation's history, which adds cost and noise. Pass true only when the child needs most of this conversation, such as its discussion and decisions, so that a brief would repeat most of it. Works with any agent_type.",
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
        if (error instanceof AgentDepthLimitError) {
          throw new ToolInputError(
            `${error.message}. Do the work in this agent instead.`,
            { cause: error },
          );
        }
        throw error;
      }
      const dashboardUrl = getDashboardConversationLink(
        result.childConversationId,
      );
      return {
        conversation_id: result.childConversationId,
        ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
      };
    },
  });
}
