import * as z from "zod";
import {
  briefLinkSchema,
  briefOutcomeStatusSchema,
} from "@/chat/briefs/schema";
import {
  searchRootConversations,
  type RootConversation,
} from "@/chat/conversations/root-search";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getDashboardConversationLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const SUMMARY_MAX_LENGTH = 1_000;
const CONVERSATION_IDS_MAX = 25;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** Provider-owned channel filter and match details for Conversation search. */
export interface ConversationSearchChannelPort {
  channelFilterSchema: z.ZodString;
  describeMatch(match: RootConversation): Promise<{
    channel_id?: string;
    channel_name?: string;
    permalink?: string;
  }>;
  resolveChannel(input: string): Promise<string>;
}

/**
 * What the agent of the Conversation does now. The words match the
 * Conversation execution status.
 */
const CONVERSATION_STATUSES = ["pending", "running", "paused", "idle"] as const;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

const conversationMatchSchema = z
  .object({
    conversation_id: z
      .string()
      .min(1)
      .describe(
        "Pass it to searchConversationEvents to read its history, or to messageAgent to message its agent.",
      ),
    status: z
      .enum(CONVERSATION_STATUSES)
      .describe(
        "What its agent does now. pending: waiting to run. running or paused: working. idle: waits for a message.",
      ),
    title: z.string().optional(),
    summary: z.string().optional().describe("Summary from the latest Brief"),
    outcome: briefOutcomeStatusSchema
      .optional()
      .describe("Outcome status from the latest Brief"),
    excerpt: z
      .string()
      .optional()
      .describe("Brief text that matches the query"),
    links: z
      .array(briefLinkSchema)
      .max(5)
      .optional()
      .describe("Top links from the latest Brief, such as pull requests"),
    channel_id: z.string().min(1).optional(),
    channel_name: z.string().min(1).optional(),
    permalink: z.string().url().optional(),
    dashboard_url: z.string().url().optional(),
    archived: z
      .literal(true)
      .optional()
      .describe("The conversation is archived."),
    transcript_purged: z
      .literal(true)
      .optional()
      .describe(
        "The transcript is purged. Only the title and the Brief remain.",
      ),
    updated_at: z.string().describe("Time of the latest activity"),
  })
  .strict();

type ConversationMatch = z.output<typeof conversationMatchSchema>;

async function conversationMatch(
  root: RootConversation,
  channels: ConversationSearchChannelPort | undefined,
): Promise<ConversationMatch> {
  const dashboardUrl = getDashboardConversationLink(root.conversationId);
  const channelFields = channels
    ? await channels.describeMatch(root)
    : undefined;
  return {
    conversation_id: root.conversationId,
    // A Conversation whose Turn failed waits for new input.
    status: root.status === "failed" ? "idle" : root.status,
    ...(root.title ? { title: root.title } : undefined),
    ...(root.summary
      ? { summary: truncate(root.summary, SUMMARY_MAX_LENGTH) }
      : undefined),
    ...(root.outcomeStatus ? { outcome: root.outcomeStatus } : undefined),
    ...(root.excerpt ? { excerpt: root.excerpt } : undefined),
    ...(root.links.length > 0 ? { links: root.links } : undefined),
    ...channelFields,
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
    ...(root.archived ? { archived: true as const } : undefined),
    ...(root.transcriptPurged
      ? { transcript_purged: true as const }
      : undefined),
    updated_at: new Date(root.updatedAtMs).toISOString(),
  };
}

const searchConversationsOutputSchema = juniorToolOutputSchema.extend({
  conversations: z
    .array(conversationMatchSchema)
    .describe("Best match first for a query, else newest activity first."),
});

function searchConversationsInputSchema(
  channels?: ConversationSearchChannelPort,
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
        .describe("Words to match in the latest Brief or the title."),
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
      conversation_ids: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(CONVERSATION_IDS_MAX)
        .nullable()
        .optional()
        .describe("Return only these conversation IDs."),
      outcome: briefOutcomeStatusSchema
        .nullable()
        .optional()
        .describe("Outcome status of the latest Brief."),
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
          `Maximum results. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
        ),
    })
    .strict();
}

/**
 * Create the read-only tool that searches the root Conversations, outside
 * this Conversation's tree, that it may find, with their latest Brief.
 */
export function createSearchConversationsTool(context: {
  channels?: ConversationSearchChannelPort;
  conversationId: string;
}) {
  const { channels } = context;
  return zodTool({
    exposure: "deferred",
    source: CONVERSATIONS_TOOL_SOURCE,
    description:
      "Search other conversations for past or current work, with the summary, outcome, and links of their latest Brief. Finds public root conversations and root conversations in the same private channel or DM. Briefs remain after transcripts are purged.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: searchConversationsInputSchema(channels),
    outputSchema: searchConversationsOutputSchema,
    execute: async (input) => {
      const annotation = input.annotation ?? undefined;
      const conversationIds = input.conversation_ids ?? undefined;
      const outcomeStatus = input.outcome ?? undefined;
      const query = input.query ?? undefined;
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
      const channelId =
        channels && channelInput
          ? await channels.resolveChannel(channelInput)
          : undefined;
      const roots = await searchRootConversations(getDb(), {
        requesterConversationId: context.conversationId,
        search: {
          ...(afterMs !== undefined ? { afterMs } : undefined),
          ...(annotation ? { annotation } : undefined),
          ...(beforeMs !== undefined ? { beforeMs } : undefined),
          ...(channelId ? { channelId } : undefined),
          ...(conversationIds ? { conversationIds } : undefined),
          includeArchived: input.include_archived ?? false,
          limit: input.limit ?? DEFAULT_LIMIT,
          ...(outcomeStatus ? { outcomeStatus } : undefined),
          ...(query ? { query } : undefined),
        },
      });
      return {
        conversations: await Promise.all(
          roots.map((root) => conversationMatch(root, channels)),
        ),
      };
    },
  });
}
