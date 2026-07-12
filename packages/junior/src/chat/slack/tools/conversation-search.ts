import { z } from "zod";
import type {
  ConversationSearchScope,
  ConversationSearchStore,
} from "@/chat/conversations/search";
import { getConversationSearchStore } from "@/chat/db";
import { parseSlackThreadId } from "@/chat/slack/context";
import { getSlackMessagePermalink } from "@/chat/slack/outbound";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";

const DEFAULT_LIMIT = 5;

const conversationSearchOutputSchema = juniorToolResultSchema.extend({
  query: z.string(),
  count: z.number().int().nonnegative(),
  threads: z.array(
    z
      .object({
        conversation_id: z.string().min(1),
        thread_ts: z.string().min(1),
        message_id: z.string().min(1),
        message_role: z.enum(["assistant", "user"]),
        message_timestamp: z.string().datetime(),
        excerpt: z.string(),
        permalink: z.string().url().optional(),
      })
      .strict(),
  ),
});

interface ConversationSearchToolDeps {
  getPermalink?: typeof getSlackMessagePermalink;
  store?: ConversationSearchStore;
}

/** Create a tool that searches retained public Junior threads across an authorized Slack workspace. */
export function createSlackConversationSearchTool(
  scope: ConversationSearchScope,
  currentConversationId: string,
  deps: ConversationSearchToolDeps = {},
) {
  return zodTool({
    description:
      "Search prior public Junior conversation threads across the current Slack workspace. Use when the user refers to an earlier public discussion, decision, or answer that is not in the current thread. Searches retained visible user and assistant messages only.",
    exposure: "deferred",
    source: {
      id: "conversation-history",
      description:
        "Search retained public Junior conversation threads in the current Slack workspace.",
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Words or a short phrase to find in prior conversations."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .describe("Maximum number of prior conversation threads to return.")
        .nullable()
        .optional(),
    }),
    outputSchema: conversationSearchOutputSchema,
    execute: async ({ query, limit }) => {
      const store = deps.store ?? getConversationSearchStore();
      const matches = await store.search({
        currentConversationId,
        limit: limit ?? DEFAULT_LIMIT,
        query,
        scope,
      });
      const getPermalink = deps.getPermalink ?? getSlackMessagePermalink;
      const threads = await Promise.all(
        matches.map(async (match) => {
          const reference = parseSlackThreadId(match.conversationId);
          if (
            !reference ||
            reference.channelId !== match.providerDestinationId
          ) {
            throw new Error(
              "Stored Slack conversation search returned an invalid destination",
            );
          }
          const permalink = await getPermalink({
            channelId: reference.channelId,
            messageTs: reference.threadTs,
          });
          return {
            conversation_id: match.conversationId,
            thread_ts: reference.threadTs,
            message_id: match.messageId,
            message_role: match.role,
            message_timestamp: new Date(match.messageCreatedAtMs).toISOString(),
            excerpt: match.excerpt,
            ...(permalink ? { permalink } : {}),
          };
        }),
      );

      return {
        ok: true,
        status: "success" as const,
        query,
        count: threads.length,
        threads,
      };
    },
  });
}
