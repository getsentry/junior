import * as z from "zod";
import {
  subscribableResourceSchema,
  type PluginEmbedder,
} from "@sentry/junior-plugin-api";
import { listAgentRelatives } from "@/chat/child-agents/list";
import {
  searchConversations,
  type ConversationSearchChannelPort,
  type ConversationSearchResult,
} from "@/chat/conversations/search";
import { AGENT_STATUSES } from "@/chat/conversations/agent-status";
import { resolveAnnotationFilter } from "@/chat/conversations/sql/annotation-filter";
import { agentWatch } from "@/chat/conversations/watch-events";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import {
  loadParentAgentFields,
  parentAgentFields,
} from "@/chat/plugins/parent-agent-fields";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import {
  agentNameSchema,
  CHILD_AGENT_KINDS,
  type ChildAgent,
} from "@/chat/child-agents/types";
import { CHILD_AGENT_RESULTS } from "@/chat/child-agents/results";
import { AGENTS_TOOL_SOURCE } from "@/chat/child-agents/tool-source";

const TASK_MAX_LENGTH = 1_000;
const SUMMARY_MAX_LENGTH = 1_000;
const CONVERSATION_IDS_MAX = 25;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** How a listed agent relates to the conversation that lists it. */
const AGENT_RELATIONS = [
  "self",
  "parent",
  "child",
  "sibling",
  "other",
] as const;
type AgentRelation = (typeof AGENT_RELATIONS)[number];

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
      .enum([...CHILD_AGENT_KINDS, "automation", "lead"])
      .optional()
      .describe(
        "thread: people can message it. task: only its parent messages it. automation or lead: a top-level conversation.",
      ),
    root_conversation_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Root of a child agent outside your team. To message about its work, pass this to messageAgent.",
      ),
    summary: z
      .string()
      .optional()
      .describe("What was asked and what happened, as of its last Turn"),
    excerpt: z
      .string()
      .optional()
      .describe("Summary text that matches the query"),
    links: z
      .array(
        z
          .object({
            label: z.string(),
            url: z.string(),
          })
          .strict(),
      )
      .max(5)
      .optional()
      .describe("Top linked resources, such as pull requests"),
    channel_id: z.string().min(1).optional(),
    channel_name: z.string().min(1).optional(),
    status: z
      .enum(AGENT_STATUSES)
      .describe(
        "What the agent does now. pending: waiting to run. running or paused: working. idle: finished its work and waits for a message. failed: its work stopped on a failure, and a message starts new work. stopped: stopAgent stopped it.",
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
    transcript_purged: z
      .literal(true)
      .optional()
      .describe(
        "The transcript is purged. Only the title and the summary remain.",
      ),
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
    status: agent.status,
    ...(agent.lastResult ? { last_result: agent.lastResult } : undefined),
    task: truncate(agent.title ?? "", TASK_MAX_LENGTH),
    ...(agent.title ? { title: agent.title } : undefined),
    ...(url ? { url } : undefined),
    ...(agent.archivedAtMs !== undefined
      ? { archived: true as const }
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

// A match outside the team.
function listedMatch(match: ConversationSearchResult): ListedAgent {
  const url = getDashboardConversationLink(match.conversationId);
  return {
    relation: "other",
    conversation_id: match.conversationId,
    ...(match.kind ? { kind: match.kind } : undefined),
    // Only a child agent has a different root.
    ...(match.rootConversationId !== match.conversationId
      ? { root_conversation_id: match.rootConversationId }
      : undefined),
    status: match.status,
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

function listAgentsInputSchema(
  channels?: Pick<ConversationSearchChannelPort, "channelFilterSchema">,
) {
  return z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .nullable()
        .optional()
        .describe("Words or meaning to match in the title or summary."),
      annotation: z
        .string()
        .trim()
        .min(1)
        .max(256)
        .nullable()
        .optional()
        .describe(
          "Linked resource, by its reference such as owner/repo#123 or by its link. owner/repo matches each resource of the repository. Matches when the conversation or one of its child agents links it.",
        ),
      conversation_ids: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(CONVERSATION_IDS_MAX)
        .nullable()
        .optional()
        .describe("Return only these conversation IDs."),
      after: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe("Activity at or after this timestamp."),
      before: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe("Activity before this timestamp."),
      ...(channels
        ? {
            channel_id: channels.channelFilterSchema
              .nullable()
              .optional()
              .describe("Channel of the conversation."),
          }
        : undefined),
      participating: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "Only conversations that the person of this Turn takes part in. Default false.",
        ),
      roots_only: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "Return only root conversations and your own team. Set false to also find other child agents by their own title, summary, or linked resources. Default true.",
        ),
      include_archived: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "Include archived conversations, such as finished past work. Default false.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .nullable()
        .optional()
        .describe(
          `Maximum search results. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
        ),
    })
    .strict();
}

/**
 * Definition of `listAgents`, with the provider channel filter when there
 * is one. Plugins add fields to the parent's entry, each named after its
 * plugin.
 */
export function listAgentsToolDefinition(
  channels?: Pick<ConversationSearchChannelPort, "channelFilterSchema">,
) {
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
    description: `List your team, with the state recorded by the runtime: the agents you started, and, for a child agent, itself, ${parent}, and its siblings. With a query or a filter, find past or current work in any conversation that you may read, your team first, with its summary and links. A root summary covers its child agents. Results of agents you started arrive as new tasks, not through this tool.`,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: listAgentsInputSchema(channels),
    outputSchema: juniorToolOutputSchema.extend({
      agents: z
        .array(listedAgentFields.extend(parentFields).strict())
        .describe(
          "Without a query or a filter: this conversation, its parent, its child agents, then its siblings, newest activity first. Otherwise the matches, your team first, then the conversations that the person you work for takes part in, best match first for a query, else newest activity first.",
        ),
    }),
  });
}

type ListAgentsInput = z.output<ReturnType<typeof listAgentsInputSchema>>;

/**
 * Create the read-only tool that lists the team of one conversation: its
 * child agents and, for a child agent, itself, its parent, and its
 * siblings. A query or a filter searches every conversation that it may
 * find, its team first.
 */
export function createListAgentsTool(
  context: TeamContext & {
    channels?: ConversationSearchChannelPort;
    /** Embeds a query to also match summaries by meaning. */
    embedder?: PluginEmbedder;
    /**
     * Reads the User id of the person, whose Conversations rank next and
     * whom `participating` filters by.
     */
    resolvePersonUserId?: () => Promise<string | undefined>;
  },
) {
  const { channels } = context;
  return zodTool({
    ...listAgentsToolDefinition(channels),
    execute: async (input: ListAgentsInput) => {
      // A field that changes what matches asks for a search. A default
      // value or a limit alone still lists the team.
      const searches =
        Boolean(input.query) ||
        Boolean(input.annotation) ||
        Boolean(input.conversation_ids) ||
        Boolean(input.after) ||
        Boolean(input.before) ||
        ("channel_id" in input && Boolean(input.channel_id)) ||
        input.participating === true ||
        input.roots_only === false ||
        input.include_archived === true;
      if (!searches) return { agents: await listTeam(context) };
      // The schema accepts only ISO-8601 timestamps.
      const afterMs = input.after ? Date.parse(input.after) : undefined;
      const beforeMs = input.before ? Date.parse(input.before) : undefined;
      if (
        afterMs !== undefined &&
        beforeMs !== undefined &&
        afterMs >= beforeMs
      ) {
        throw new ToolInputError("`after` must be earlier than `before`");
      }
      const channelInput =
        "channel_id" in input && typeof input.channel_id === "string"
          ? input.channel_id
          : undefined;
      const [team, personUserId, channelId] = await Promise.all([
        listTeam(context),
        context.resolvePersonUserId?.(),
        channels && channelInput
          ? channels.resolveChannel(channelInput)
          : undefined,
      ]);
      if (input.participating && !personUserId) {
        throw new ToolInputError(
          "`participating` needs a person: this Turn has none. Leave out `participating`.",
        );
      }
      const annotation = input.annotation
        ? await resolveAnnotationFilter(getDb(), input.annotation)
        : undefined;
      const matches = await searchConversations(getDb(), {
        ...(context.embedder ? { embedder: context.embedder } : undefined),
        requesterConversationId: context.conversationId,
        search: {
          ...(afterMs !== undefined ? { afterMs } : undefined),
          ...(annotation ? { annotation } : undefined),
          ...(beforeMs !== undefined ? { beforeMs } : undefined),
          ...(channelId ? { channelId } : undefined),
          ...(input.conversation_ids
            ? { conversationIds: input.conversation_ids }
            : undefined),
          includeArchived: input.include_archived ?? false,
          limit: input.limit ?? DEFAULT_LIMIT,
          ...(input.participating && personUserId
            ? { participantUserId: personUserId }
            : undefined),
          ...(input.query ? { query: input.query } : undefined),
          rootsOnly: input.roots_only ?? true,
          team: { personUserId },
        },
      });
      // A team member keeps the state and relation of the team listing.
      const members = new Map(
        team.map((agent) => [agent.conversation_id, agent]),
      );
      return {
        agents: await mapBounded(matches, async (match) => {
          const listed =
            members.get(match.conversationId) ?? listedMatch(match);
          // Link the dashboard. The provider thread is only a fallback.
          const channelFields = channels
            ? await channels.describeMatch(match, { includeUrl: !listed.url })
            : undefined;
          return {
            ...listed,
            ...channelFields,
            ...(match.summary
              ? { summary: truncate(match.summary, SUMMARY_MAX_LENGTH) }
              : undefined),
            ...(match.excerpt ? { excerpt: match.excerpt } : undefined),
            ...(match.links.length > 0 ? { links: match.links } : undefined),
            ...(match.transcriptPurged
              ? { transcript_purged: true as const }
              : undefined),
          };
        }),
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
            status: parent.status,
            updated_at: new Date(parent.updatedAtMs).toISOString(),
            ...details,
          },
        ]
      : []),
    ...children.map((agent) => listedChildAgent("child", agent)),
    ...siblings.map((agent) => listedChildAgent("sibling", agent)),
  ];
}
