import { z } from "zod";
import { listChildAgents } from "@/chat/agent-invocations/list";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  agentNameSchema,
  CHILD_AGENT_RESULTS,
  type ChildAgent,
} from "@/chat/agent-invocations/types";

const TASK_MAX_LENGTH = 1_000;
const ERROR_MAX_LENGTH = 500;

/**
 * What a child agent does now. The words match the Conversation execution
 * status, plus `stopped` after stopAgent.
 */
const CHILD_AGENT_STATUSES = [
  "pending",
  "running",
  "paused",
  "idle",
  "stopped",
] as const;

function childAgentStatus(
  agent: ChildAgent,
): (typeof CHILD_AGENT_STATUSES)[number] {
  switch (agent.status) {
    case "pending":
    case "running":
    case "paused":
    case "stopped":
      return agent.status;
    case "blocked":
    case "completed":
    case "failed":
      return "idle";
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const listAgentsOutputSchema = juniorToolOutputSchema.extend({
  agents: z
    .array(
      z
        .object({
          conversation_id: z
            .string()
            .min(1)
            .describe(
              "Child conversation ID. Pass it to searchConversationEvents to read the child's history.",
            ),
          name: agentNameSchema
            .optional()
            .describe("Child-agent name. Pass it to messageAgent."),
          status: z
            .enum(CHILD_AGENT_STATUSES)
            .describe(
              "What the child agent does now. pending: waiting to run. running or paused: working. idle: finished its work and waits for a message. stopped: stopAgent stopped it.",
            ),
          last_result: z
            .enum(CHILD_AGENT_RESULTS)
            .optional()
            .describe("How the latest finished task of the child agent ended"),
          task: z.string().describe("Latest task given to the child agent"),
          title: z
            .string()
            .optional()
            .describe("Short display title of the latest task"),
          error: z
            .string()
            .optional()
            .describe("Why the child agent is blocked, failed, or stopped"),
          updated_at: z.string().describe("Time of the latest change"),
        })
        .strict(),
    )
    .describe("Child agents of this conversation, newest activity first"),
});

/** Create the read-only tool that lists the child agents of one conversation. */
export function createListAgentsTool(conversationId: string) {
  return zodTool({
    description:
      "List the child agents that this conversation started, with the state recorded by the runtime. Use it to check which child agents are still working, or to find a child agent before you give it more work with messageAgent. Results still arrive as new tasks; do not poll with this tool.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z.object({}).strict(),
    outputSchema: listAgentsOutputSchema,
    execute: async () => ({
      agents: (await listChildAgents(conversationId)).map((agent) => ({
        conversation_id: agent.childConversationId,
        ...(agent.agentName ? { name: agent.agentName } : undefined),
        status: childAgentStatus(agent),
        ...(agent.lastResult ? { last_result: agent.lastResult } : undefined),
        task: truncate(agent.task, TASK_MAX_LENGTH),
        ...(agent.title ? { title: agent.title } : undefined),
        ...(agent.errorMessage
          ? { error: truncate(agent.errorMessage, ERROR_MAX_LENGTH) }
          : undefined),
        updated_at: new Date(agent.updatedAtMs).toISOString(),
      })),
    }),
  });
}
