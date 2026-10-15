import { z } from "zod";
import {
  listAgentRelatives,
  type ParentAgent,
} from "@/chat/agent-invocations/list";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import {
  agentNameSchema,
  CHILD_AGENT_RESULTS,
  type ChildAgent,
} from "@/chat/agent-invocations/types";

const TASK_MAX_LENGTH = 1_000;
const ERROR_MAX_LENGTH = 500;

/** How a listed agent relates to the conversation that lists it. */
const AGENT_RELATIONS = ["self", "parent", "child", "sibling"] as const;
type AgentRelation = (typeof AGENT_RELATIONS)[number];

/**
 * What an agent does now. The words match the Conversation execution
 * status, plus `stopped` after stopAgent.
 */
const LISTED_AGENT_STATUSES = [
  "pending",
  "running",
  "paused",
  "idle",
  "stopped",
] as const;

type ListedAgentStatus = (typeof LISTED_AGENT_STATUSES)[number];

function childAgentStatus(agent: ChildAgent): ListedAgentStatus {
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

function parentAgentStatus(agent: ParentAgent): ListedAgentStatus {
  // A Conversation whose Turn failed waits for new input.
  return agent.status === "failed" ? "idle" : agent.status;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const listedAgentSchema = z
  .object({
    relation: z
      .enum(AGENT_RELATIONS)
      .describe(
        "self: this conversation. parent: the agent that started it. child: an agent that it started. sibling: another child of its parent.",
      ),
    conversation_id: z
      .string()
      .min(1)
      .describe(
        "Agent conversation ID. Pass it to searchConversationEvents to read the agent's history.",
      ),
    name: agentNameSchema
      .optional()
      .describe(
        "Agent name given by its parent. Pass the name of a child agent to messageAgent.",
      ),
    status: z
      .enum(LISTED_AGENT_STATUSES)
      .describe(
        "What the agent does now. pending: waiting to run. running or paused: working. idle: finished its work and waits for a message. stopped: stopAgent stopped it.",
      ),
    last_result: z
      .enum(CHILD_AGENT_RESULTS)
      .optional()
      .describe("How the latest finished task of the agent ended"),
    task: z
      .string()
      .optional()
      .describe(
        "Latest task that its parent gave the agent. Not shown for the parent.",
      ),
    title: z
      .string()
      .optional()
      .describe("Short display title of the latest task"),
    error: z
      .string()
      .optional()
      .describe("Why the agent is blocked, failed, or stopped"),
    updated_at: z.string().describe("Time of the latest change"),
  })
  .strict();

type ListedAgent = z.output<typeof listedAgentSchema>;

function listedChildAgent(
  relation: AgentRelation,
  agent: ChildAgent,
): ListedAgent {
  return {
    relation,
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
  };
}

const listAgentsOutputSchema = juniorToolOutputSchema.extend({
  agents: z
    .array(listedAgentSchema)
    .describe(
      "This conversation, its parent, its child agents, then its siblings. Child agents and siblings show the newest activity first.",
    ),
});

/**
 * Create the read-only tool that lists the agents one conversation can see:
 * its child agents and, for a child agent, itself, its parent, and its
 * siblings.
 */
export function createListAgentsTool(context: {
  conversationId: string;
  parentConversationId?: string;
}) {
  return zodTool({
    description:
      "List the agents that this conversation can see, with the state recorded by the runtime: the child agents it started and, for a child agent, itself, its parent, and its siblings. Use it to check which agents are still working, to see what your siblings work on, or to find a child agent before you give it more work with messageAgent. Results still arrive as new tasks; do not poll with this tool.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z.object({}).strict(),
    outputSchema: listAgentsOutputSchema,
    execute: async () => {
      const { children, parent, self, siblings } =
        await listAgentRelatives(context);
      return {
        agents: [
          ...(self ? [listedChildAgent("self", self)] : []),
          ...(parent
            ? [
                {
                  relation: "parent" as const,
                  conversation_id: parent.conversationId,
                  status: parentAgentStatus(parent),
                  updated_at: new Date(parent.updatedAtMs).toISOString(),
                },
              ]
            : []),
          ...children.map((agent) => listedChildAgent("child", agent)),
          ...siblings.map((agent) => listedChildAgent("sibling", agent)),
        ],
      };
    },
  });
}
