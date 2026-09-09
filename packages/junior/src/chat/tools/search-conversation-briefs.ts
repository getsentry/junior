import { z } from "zod";
import { briefOutcomeStatusSchema, briefLinkSchema } from "@/chat/briefs/brief";
import type {
  ConversationBriefSearchFilters,
  ConversationBriefSearchScope,
} from "@/chat/briefs/search";
import { CONVERSATIONS_TOOL_SOURCE } from "@/chat/conversations/tool-source";
import { getConversationBriefSearchStore } from "@/chat/db";
import { parseSlackThreadId } from "@/chat/slack/context";
import { getDashboardConversationLink } from "@/chat/slack/dashboard-link";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import {
  resolveSlackChannelRef,
  slackChannelRefParam,
} from "@/chat/slack/tool-support/channel-target";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const conversationBriefSearchOutputSchema = juniorToolOutputSchema.extend({
  after: z.string().datetime().optional(),
  annotation: z.string().min(1).optional(),
  before: z.string().datetime().optional(),
  channel_id: z.string().min(1).optional(),
  count: z.number().int().nonnegative(),
  matches: z.array(
    z
      .object({
        channel_id: z.string().min(1).optional(),
        channel_name: z.string().min(1).optional(),
        conversation_id: z.string().min(1),
        dashboard_url: z.string().url().optional(),
        excerpt: z.string(),
        links: z.array(briefLinkSchema).max(5),
        permalink: z.string().url().optional(),
        status: briefOutcomeStatusSchema,
        summary: z.string().min(1),
        title: z.string().min(1).optional(),
        updated_at: z.string().datetime(),
        version: z.number().int().positive(),
      })
      .strict(),
  ),
  query: z.string().optional(),
  status: briefOutcomeStatusSchema.optional(),
});

function parseTimestamp(
  field: "after" | "before",
  value: string | null | undefined,
): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ToolInputError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return parsed;
}

async function resolveSearchFilters(
  scope: ConversationBriefSearchScope,
  input: {
    after?: string | null;
    annotation?: string | null;
    before?: string | null;
    channel_id?: string | null;
    query?: string | null;
    status?: z.output<typeof briefOutcomeStatusSchema> | null;
  },
): Promise<ConversationBriefSearchFilters> {
  const query = input.query?.trim() || undefined;
  const annotation = input.annotation?.trim() || undefined;
  const afterMs = parseTimestamp("after", input.after);
  const beforeMs = parseTimestamp("before", input.before);
  let channelId: string | undefined;

  if (input.channel_id != null && input.channel_id.trim() !== "") {
    if (scope.kind !== "public_provider_tenant") {
      throw new ToolInputError(
        "channel_id is available only in Slack searches",
      );
    }
    const teamId = parseSlackTeamId(scope.providerTenantId);
    if (!teamId) {
      throw new ToolInputError(
        "Cannot search Briefs without a valid Slack workspace id.",
      );
    }
    const target = await resolveSlackChannelRef({
      field: "channel_id",
      value: input.channel_id,
      teamId,
    });
    channelId = target.channelId;
  }

  if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
    throw new ToolInputError("`after` must be earlier than `before`");
  }
  return {
    ...(afterMs !== undefined ? { afterMs } : undefined),
    ...(annotation ? { annotation } : undefined),
    ...(beforeMs !== undefined ? { beforeMs } : undefined),
    ...(channelId ? { channelId } : undefined),
    ...(query ? { query } : undefined),
    ...(input.status ? { status: input.status } : undefined),
  };
}

/** Create a deferred tool that searches the latest public Conversation Briefs. */
export function createSearchConversationBriefsTool(
  scope: ConversationBriefSearchScope,
  currentConversationId: string,
) {
  return zodTool({
    description:
      "Search Briefs from past public conversations. Briefs preserve intent, outcomes, decisions, facts, and links after transcripts expire. Use this before searchConversationMessages for questions such as what was decided or which pull request handled the work.",
    exposure: "deferred",
    source: CONVERSATIONS_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        after: z
          .string()
          .datetime()
          .nullable()
          .describe("Include Briefs updated at or after this timestamp.")
          .optional(),
        annotation: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullable()
          .describe(
            "Linked resource key. Matches that key, or nested children that continue with #.",
          )
          .optional(),
        before: z
          .string()
          .datetime()
          .nullable()
          .describe("Include Briefs updated before this timestamp.")
          .optional(),
        channel_id: slackChannelRefParam
          .nullable()
          .describe(
            "Slack channel filter. Available only in Slack conversations.",
          )
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .nullable()
          .describe(
            `Maximum conversations. Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`,
          )
          .optional(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .nullable()
          .describe("Words or phrase to match in current Briefs.")
          .optional(),
        status: briefOutcomeStatusSchema
          .nullable()
          .describe("Current Brief outcome status.")
          .optional(),
      })
      .strict(),
    outputSchema: conversationBriefSearchOutputSchema,
    execute: async (input) => {
      const filters = await resolveSearchFilters(scope, input);
      const matches = await getConversationBriefSearchStore().search({
        currentConversationId,
        filters,
        limit: input.limit ?? DEFAULT_LIMIT,
        scope,
      });
      const outputMatches = await Promise.all(
        matches.map(async (match) => {
          const reference = parseSlackThreadId(match.conversationId);
          const slackReference =
            reference && reference.channelId === match.providerDestinationId
              ? reference
              : undefined;
          const permalink = slackReference
            ? await getSlackMessagePermalink({
                channelId: slackReference.channelId,
                messageTs: slackReference.threadTs,
              })
            : undefined;
          const dashboardUrl = getDashboardConversationLink(
            match.conversationId,
          );
          return {
            conversation_id: match.conversationId,
            status: match.outcomeStatus,
            updated_at: new Date(match.updatedAtMs).toISOString(),
            version: match.version,
            summary: match.summary,
            excerpt: match.excerpt,
            links: match.links,
            ...(match.title ? { title: match.title } : undefined),
            ...(slackReference
              ? { channel_id: slackReference.channelId }
              : undefined),
            ...(slackReference && match.channelName
              ? { channel_name: match.channelName }
              : undefined),
            ...(dashboardUrl ? { dashboard_url: dashboardUrl } : undefined),
            ...(permalink ? { permalink } : undefined),
          };
        }),
      );
      return {
        ...(filters.afterMs !== undefined
          ? { after: new Date(filters.afterMs).toISOString() }
          : undefined),
        ...(filters.annotation
          ? { annotation: filters.annotation }
          : undefined),
        ...(filters.beforeMs !== undefined
          ? { before: new Date(filters.beforeMs).toISOString() }
          : undefined),
        ...(filters.channelId ? { channel_id: filters.channelId } : undefined),
        ...(filters.query ? { query: filters.query } : undefined),
        ...(filters.status ? { status: filters.status } : undefined),
        count: outputMatches.length,
        matches: outputMatches,
      };
    },
  });
}
