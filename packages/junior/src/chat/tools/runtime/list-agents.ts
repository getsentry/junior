import * as z from "zod";
import {
  subscribableResourceSchema,
  type PluginEmbedder,
} from "@sentry/junior-plugin-api";
import { listAgentRelatives, type ParentAgent } from "@/chat/child-agents/list";
import {
  searchConversations,
  type ConversationSearchResult,
} from "@/chat/conversations/search";
import type { ConversationStatus } from "@/chat/conversations/store";
import { agentWatch } from "@/chat/conversations/watch-events";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import {
  loadParentAgentFields,
  parentAgentFields,
} from "@/chat/plugins/parent-agent-fields";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import {
  agentNameSchema,
  CHILD_AGENT_KINDS,
  CHILD_AGENT_RESULTS,
  type ChildAgent,
} from "@/chat/child-agents/types";
import { AGENTS_TOOL_SOURCE } from "@/chat/child-agents/tool-source";

const TASK_MAX_LENGTH = 1_000;
const ERROR_MAX_LENGTH = 500;
const SUMMARY_MAX_LENGTH = 1_000;
const QUERY_LIMIT = 10;

/** How a listed agent relates to the conversation that lists it. */
const AGENT_RELATIONS = [
  "self",
  "parent",
  "child",
  "sibling",
  "other",
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
    case "running":
    case "stopped":
      return agent.status;
    case "blocked":
    case "completed":
    case "failed":
      return "idle";
  }
}

// A Conversation whose Turn failed waits for new input.
function conversationAgentStatus(
  status: ConversationStatus,
): ListedAgentStatus {
  return status === "failed" ? "idle" : status;
}

function parentAgentStatus(agent: ParentAgent): ListedAgentStatus {
  return conversationAgentStatus(agent.status);
}

// The model learns how much was cut and where the rest is.
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.length - maxLength;
  return `${text.slice(0, maxLength)}… [${cut} more characters cut. Read the conversation with searchConversationEvents.]`;
}

const listedAgentFields = z
  .object({
    relation: z
      .enum(AGENT_RELATIONS)
      .describe(
        "self: this conversation. parent: the agent that started it. child: a child agent that it started. sibling: another child of its parent. other: a search match outside your team.",
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
    kind: z
      .enum(CHILD_AGENT_KINDS)
      .optional()
      .describe(
        "Kind of a child or sibling. thread: people can message it. task: only its parent messages it.",
      ),
    summary: z
      .string()
      .optional()
      .describe("What was asked and what happened, as of its last Turn"),
    status: z
      .enum(LISTED_AGENT_STATUSES)
      .describe(
        "What the agent does now. pending: waiting to run. running or paused: working. idle: finished its work and waits for a message. stopped: stopAgent stopped it.",
      ),
    last_result: z
      .enum(CHILD_AGENT_RESULTS)
      .optional()
      .describe(
        "How the agent's latest finished Turn ended, as the status of its agent result",
      ),
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
    url: z.string().url().optional().describe("Link to the conversation"),
    archived: z
      .literal(true)
      .optional()
      .describe("The conversation is archived."),
    error: z
      .string()
      .optional()
      .describe("Why the agent is blocked, failed, or stopped"),
    updated_at: z.string().describe("Time of the latest change"),
    subscribable: subscribableResourceSchema
      .optional()
      .describe(
        "Watch it with watchEvents to hear its updates. Only on siblings and other matches, whose updates do not arrive by themselves.",
      ),
  })
  .strict();

type ListedAgent = z.output<typeof listedAgentFields>;

// Results of a child agent arrive as new tasks, so only a sibling or a
// match outside the team offers a Watch.
function listedChildAgent(
  relation: AgentRelation,
  agent: ChildAgent,
): ListedAgent {
  const url = getDashboardConversationLink(agent.childConversationId);
  return {
    relation,
    conversation_id: agent.childConversationId,
    ...(agent.agentName ? { name: agent.agentName } : undefined),
    kind: agent.kind,
    status: childAgentStatus(agent),
    ...(agent.lastResult ? { last_result: agent.lastResult } : undefined),
    task: truncate(agent.task, TASK_MAX_LENGTH),
    ...(agent.title ? { title: agent.title } : undefined),
    ...(url ? { url } : undefined),
    ...(agent.archivedAtMs !== undefined
      ? { archived: true as const }
      : undefined),
    ...(agent.errorMessage
      ? { error: truncate(agent.errorMessage, ERROR_MAX_LENGTH) }
      : undefined),
    updated_at: new Date(agent.updatedAtMs).toISOString(),
    ...(relation === "sibling"
      ? {
          subscribable: agentWatch({
            conversationId: agent.childConversationId,
            title: agent.title ?? agent.agentName ?? agent.childConversationId,
          }),
        }
      : undefined),
  };
}

// A match outside the team. With rootsOnly, it is a root.
function listedMatch(match: ConversationSearchResult): ListedAgent {
  const url = getDashboardConversationLink(match.conversationId);
  return {
    relation: "other",
    conversation_id: match.conversationId,
    status: conversationAgentStatus(match.status),
    ...(match.title ? { title: match.title } : undefined),
    ...(url ? { url } : undefined),
    ...(match.archived ? { archived: true as const } : undefined),
    updated_at: new Date(match.updatedAtMs).toISOString(),
    subscribable: agentWatch({
      conversationId: match.conversationId,
      title: match.title ?? match.conversationId,
    }),
  };
}

/**
 * Definition of `listAgents`. Plugins add fields to the parent's entry, each
 * named after its plugin.
 */
export function listAgentsToolDefinition() {
  const fields = [...parentAgentFields()];
  // `ListedAgent` types only the fields of core, so plugin fields have no
  // static keys here.
  const parentFields: Record<never, z.ZodType> = Object.fromEntries(
    fields.map(([name, { field }]) => [name, field.schema.optional()]),
  );
  const parentDetails = fields.map(([, { field }]) => field.description);
  const parent =
    parentDetails.length > 0
      ? `its parent with ${parentDetails.join(" and ")}`
      : "its parent";
  return zodToolDefinition({
    exposure: "deferred",
    source: AGENTS_TOOL_SOURCE,
    description: `List your team, with the state recorded by the runtime: the agents you started, and, for a child agent, itself, ${parent}, and its siblings. With a query, find any conversation that you may read, your team first. Results of agents you started arrive as new tasks, not through this tool.`,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .optional()
          .describe(
            "Words or meaning to match in the title or summary of any conversation that you may read. Omit it to list your team.",
          ),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema.extend({
      agents: z
        .array(listedAgentFields.extend(parentFields).strict())
        .describe(
          "Without a query: this conversation, its parent, its child agents, then its siblings, newest activity first. With a query: the best matches, your team first, then the conversations that the person you work for takes part in.",
        ),
    }),
  });
}

/**
 * Create the read-only tool that lists the team of one conversation: its
 * child agents and, for a child agent, itself, its parent, and its
 * siblings. A query searches every
 * conversation that it may find, its team first.
 */
export function createListAgentsTool(
  context: TeamContext & {
    /** Embeds a query to also match summaries by meaning. */
    embedder?: PluginEmbedder;
    /** Reads the User id of the person, whose Conversations rank next. */
    resolvePersonUserId?: () => Promise<string | undefined>;
  },
) {
  return zodTool({
    ...listAgentsToolDefinition(),
    execute: async (input) => {
      const query = input.query ?? undefined;
      if (!query) return { agents: await listTeam(context) };
      const [team, personUserId] = await Promise.all([
        listTeam(context),
        context.resolvePersonUserId?.(),
      ]);
      const matches = await searchConversations(getDb(), {
        ...(context.embedder ? { embedder: context.embedder } : undefined),
        requesterConversationId: context.conversationId,
        search: {
          includeArchived: false,
          limit: QUERY_LIMIT,
          query,
          rootsOnly: true,
          team: { personUserId },
        },
      });
      // A team member keeps the state and relation of the team listing.
      const members = new Map(
        team.map((agent) => [agent.conversation_id, agent]),
      );
      return {
        agents: matches.map((match) => ({
          ...(members.get(match.conversationId) ?? listedMatch(match)),
          ...(match.summary
            ? { summary: truncate(match.summary, SUMMARY_MAX_LENGTH) }
            : undefined),
        })),
      };
    },
  });
}

type TeamContext = {
  conversationId: string;
  parentConversationId?: string | undefined;
};

/**
 * List the team of one conversation: itself and its parent for a child
 * agent, its child agents, then its siblings.
 */
async function listTeam(
  context: TeamContext,
): Promise<Array<ListedAgent & Record<string, unknown>>> {
  const { children, parent, self, siblings } =
    await listAgentRelatives(context);
  // listAgentRelatives reads the parent only from the runtime context,
  // so a child reads only its own parent's details.
  const details = parent
    ? await loadParentAgentFields({
        conversationId: context.conversationId,
        parentConversationId: parent.conversationId,
      })
    : {};
  return [
    ...(self ? [listedChildAgent("self", self)] : []),
    ...(parent
      ? [
          {
            relation: "parent" as const,
            conversation_id: parent.conversationId,
            status: parentAgentStatus(parent),
            updated_at: new Date(parent.updatedAtMs).toISOString(),
            ...details,
          },
        ]
      : []),
    ...children.map((agent) => listedChildAgent("child", agent)),
    ...siblings.map((agent) => listedChildAgent("sibling", agent)),
  ];
}
