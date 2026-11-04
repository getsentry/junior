import { z } from "zod";
import type { Actor } from "@/chat/actor";
import {
  listAgentRelatives,
  type ParentAgent,
} from "@/chat/agent-invocations/list";
import {
  searchTopLevelAgents,
  type TopLevelAgent,
} from "@/chat/agent-invocations/search-top-level";
import { conversationIdsWithAnnotation } from "@/chat/conversations/sql/annotation-filter";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { readActorIdentity } from "@/chat/plugins/viewer";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  agentNameSchema,
  CHILD_AGENT_RESULTS,
  type ChildAgent,
} from "@/chat/agent-invocations/types";

const TASK_MAX_LENGTH = 1_000;
const ERROR_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 1_000;
const CONVERSATION_IDS_MAX = 25;
const TOP_LEVEL_DEFAULT_LIMIT = 10;
const TOP_LEVEL_MAX_LIMIT = 25;

/** How a listed agent relates to the conversation that lists it. */
const AGENT_RELATIONS = [
  "self",
  "parent",
  "child",
  "sibling",
  "top_level",
] as const;
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

function conversationAgentStatus(
  agent: ParentAgent | TopLevelAgent,
): ListedAgentStatus {
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
        "self: this conversation. parent: the agent that started it. child: an agent that it started. sibling: another child of its parent. top_level: another public root conversation in this workspace.",
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
      .describe(
        "Short display title of the latest task, or of a top-level conversation",
      ),
    summary: z
      .string()
      .optional()
      .describe("Summary from the latest Brief of a top-level conversation"),
    dashboard_url: z
      .string()
      .url()
      .optional()
      .describe("Dashboard link of a top-level conversation"),
    archived: z
      .literal(true)
      .optional()
      .describe(
        "You archived this conversation. Only a root conversation can be archived.",
      ),
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

function listedTopLevelAgent(agent: TopLevelAgent): ListedAgent {
  const dashboardUrl = getDashboardConversationLink(agent.conversationId);
  return {
    relation: "top_level",
    conversation_id: agent.conversationId,
    status: conversationAgentStatus(agent),
    ...(agent.title ? { title: agent.title } : undefined),
    ...(agent.summary
      ? { summary: truncate(agent.summary, SUMMARY_MAX_LENGTH) }
      : undefined),
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
    ...(agent.archived ? { archived: true as const } : undefined),
    updated_at: new Date(agent.updatedAtMs).toISOString(),
  };
}

/** Whether one related agent matches every filter. */
function matchesRelativeFilters(
  agent: ListedAgent,
  filters: { conversationIds?: ReadonlySet<string>; query?: string },
): boolean {
  if (
    filters.conversationIds &&
    !filters.conversationIds.has(agent.conversation_id)
  ) {
    return false;
  }
  if (!filters.query) {
    return true;
  }
  const query = filters.query.toLowerCase();
  return [agent.name, agent.title, agent.task].some((text) =>
    text?.toLowerCase().includes(query),
  );
}

const searchAgentsOutputSchema = juniorToolOutputSchema.extend({
  agents: z
    .array(listedAgentSchema)
    .describe(
      "relatives: this conversation, its parent, its child agents, then its siblings, newest activity first. top_level: best match first for a query, else newest activity first.",
    ),
});

const searchAgentsInputSchema = z
  .object({
    scope: z
      .enum(["relatives", "top_level"])
      .nullable()
      .optional()
      .describe(
        "relatives (default): this conversation, its parent, its child agents, and its siblings. top_level: other public root conversations in this workspace. Only a root conversation can search top_level.",
      ),
    conversation_ids: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(CONVERSATION_IDS_MAX)
      .nullable()
      .optional()
      .describe("Return only these conversation IDs."),
    annotation: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .optional()
      .describe(
        "Linked resource key, such as owner/repo#123 for a pull request. Matches that key, or nested children that continue with #. Matches a conversation when it or one of its child agents created, changed, or read the resource.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        "Words to match. relatives: the name, title, or task. top_level: the latest Brief or the title.",
      ),
    include_archived: z
      .boolean()
      .nullable()
      .optional()
      .describe(
        "Include conversations that you archived. Default false. Child agents cannot be archived, so this changes only top_level results.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(TOP_LEVEL_MAX_LIMIT)
      .nullable()
      .optional()
      .describe(
        `Maximum top_level results. Default ${TOP_LEVEL_DEFAULT_LIMIT}; max ${TOP_LEVEL_MAX_LIMIT}. Relatives are not limited.`,
      ),
  })
  .strict();

/**
 * Create the read-only tool that searches the agents one conversation can
 * see: its relatives (child agents and, for a child agent, itself, its
 * parent, and its siblings) or the top-level agents it may reach.
 */
export function createSearchAgentsTool(context: {
  actor?: Actor;
  conversationId: string;
  parentConversationId?: string;
}) {
  return zodTool({
    description:
      "Search the agents that this conversation can see, with the state recorded by the runtime. Relatives are the child agents it started and, for a child agent, itself, its parent, and its siblings. Top-level agents are other public root conversations in this workspace. messageAgent can send to one only when this conversation is public too. Results of child agents arrive as new tasks, not through this tool.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: searchAgentsInputSchema,
    outputSchema: searchAgentsOutputSchema,
    execute: async (input) => {
      const annotation = input.annotation ?? undefined;
      const conversationIds = input.conversation_ids ?? undefined;
      const query = input.query ?? undefined;
      if (input.scope === "top_level") {
        if (context.parentConversationId) {
          throw new ToolInputError(
            "A child agent cannot search top_level agents. Search relatives instead.",
          );
        }
        const viewer = context.actor
          ? (await readActorIdentity(context.actor))?.user
          : undefined;
        const agents = await searchTopLevelAgents({
          requesterConversationId: context.conversationId,
          search: {
            ...(annotation ? { annotation } : undefined),
            ...(conversationIds ? { conversationIds } : undefined),
            includeArchived: input.include_archived ?? false,
            limit: input.limit ?? TOP_LEVEL_DEFAULT_LIMIT,
            ...(query ? { query } : undefined),
          },
          ...(viewer ? { viewer } : undefined),
        });
        return { agents: agents.map(listedTopLevelAgent) };
      }
      const { children, parent, self, siblings } =
        await listAgentRelatives(context);
      const agents: ListedAgent[] = [
        ...(self ? [listedChildAgent("self", self)] : []),
        ...(parent
          ? [
              {
                relation: "parent" as const,
                conversation_id: parent.conversationId,
                status: conversationAgentStatus(parent),
                updated_at: new Date(parent.updatedAtMs).toISOString(),
              },
            ]
          : []),
        ...children.map((agent) => listedChildAgent("child", agent)),
        ...siblings.map((agent) => listedChildAgent("sibling", agent)),
      ];
      const filters = {
        ...(conversationIds
          ? { conversationIds: new Set(conversationIds) }
          : undefined),
        ...(query ? { query } : undefined),
      };
      const matches = agents.filter((agent) =>
        matchesRelativeFilters(agent, filters),
      );
      if (!annotation) {
        return { agents: matches };
      }
      const annotated = await conversationIdsWithAnnotation(
        getDb(),
        matches.map((agent) => agent.conversation_id),
        annotation,
      );
      return {
        agents: matches.filter((agent) => annotated.has(agent.conversation_id)),
      };
    },
  });
}
