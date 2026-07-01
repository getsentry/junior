import { Type } from "@sinclair/typebox";
import type {
  ConversationCompaction,
  ConversationMessage,
} from "@/chat/state/conversation";
import { tool } from "@/chat/tools/definition";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_LIMIT,
  includeLinksInput,
} from "@/chat/tools/transcripts/constants";
import {
  loadTranscriptState,
  resolveTranscriptToolDeps,
  type TranscriptToolDeps,
} from "@/chat/tools/transcripts/deps";
import { limit } from "@/chat/tools/transcripts/limits";
import { linkForMessage } from "@/chat/tools/transcripts/links";
import {
  inputError,
  isoTime,
  projectCompaction,
  projectMessage,
  resultContent,
} from "@/chat/tools/transcripts/projection";
import { visitVisibleTranscripts } from "@/chat/tools/transcripts/scan";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function messageMatches(message: ConversationMessage, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const text = message.text.toLowerCase();
  if (text.includes(normalizedQuery)) {
    return true;
  }
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => text.includes(term));
}

function compactionMatches(
  compaction: ConversationCompaction,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const summary = compaction.summary.toLowerCase();
  if (summary.includes(normalizedQuery)) {
    return true;
  }
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => summary.includes(term));
}

/** Create a tool that searches saved Junior transcripts visible from the current runtime context. */
export function createTranscriptSearchTool(
  context: ToolRuntimeContext,
  deps?: TranscriptToolDeps,
) {
  return tool({
    description:
      "Search saved Junior conversation transcripts by keyword within the current context visibility. Public Slack channels in the workspace may be visible; private and direct Slack transcripts are limited to the current Slack source or same-workspace destination channel, and local transcripts are limited to the current local source.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      query: Type.String({
        minLength: 1,
        description: "Keyword query to match against saved transcript text.",
      }),
      include_links: includeLinksInput,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: "Maximum number of matching messages to return.",
        }),
      ),
    }),
    execute: async ({ include_links, limit: inputLimit, query }) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return inputError("Transcript search query is required.");
      }

      const resolvedDeps = resolveTranscriptToolDeps(deps);
      const resultLimit = limit(inputLimit, DEFAULT_SEARCH_LIMIT);
      const matches: Array<Record<string, unknown>> = [];

      await visitVisibleTranscripts({
        context,
        conversationStore: resolvedDeps.conversationStore,
        resultLimit,
        visit: async (access) => {
          const conversation = access.conversation;
          const state = await loadTranscriptState(
            resolvedDeps,
            conversation.conversationId,
          );
          for (const compaction of state.compactions) {
            if (!compactionMatches(compaction, trimmedQuery)) {
              continue;
            }
            matches.push({
              conversation_id: conversation.conversationId,
              destination: access.destination,
              display_name: conversation.channelName,
              title: conversation.title,
              last_activity_at: isoTime(conversation.lastActivityAtMs),
              compaction: projectCompaction({
                compaction,
                query: trimmedQuery,
              }),
            });
            if (matches.length >= resultLimit) {
              break;
            }
          }
          if (matches.length >= resultLimit) {
            return true;
          }
          for (const message of state.messages) {
            if (!messageMatches(message, trimmedQuery)) {
              continue;
            }
            const link = await linkForMessage({
              access,
              deps: resolvedDeps,
              includeLinks: include_links ?? true,
              message,
            });
            matches.push({
              conversation_id: conversation.conversationId,
              destination: access.destination,
              display_name: conversation.channelName,
              title: conversation.title,
              last_activity_at: isoTime(conversation.lastActivityAtMs),
              message: projectMessage({
                link,
                message,
                query: trimmedQuery,
              }),
            });
            if (matches.length >= resultLimit) {
              break;
            }
          }
          return matches.length >= resultLimit;
        },
      });

      return resultContent({
        ok: true,
        query: trimmedQuery,
        count: matches.length,
        matches,
      });
    },
  });
}
