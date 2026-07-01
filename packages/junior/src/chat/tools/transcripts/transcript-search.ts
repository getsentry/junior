import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_LIMIT,
  includeLinksInput,
  inputError,
  isoTime,
  limit,
  linkForMessage,
  projectCompaction,
  projectMessage,
  resultContent,
  type TranscriptToolDeps,
  loadTranscriptState,
  resolveTranscriptToolDeps,
  visitVisibleTranscripts,
} from "@/chat/tools/transcripts/shared";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function textMatches(
  text: string,
  normalizedQuery: string,
  terms: string[],
): boolean {
  const normalizedText = text.toLowerCase();
  if (normalizedText.includes(normalizedQuery)) {
    return true;
  }
  return terms.every((term) => normalizedText.includes(term));
}

/** Create a tool that searches saved Junior transcripts visible from the current runtime context. */
export function createTranscriptSearchTool(
  context: ToolRuntimeContext,
  deps?: TranscriptToolDeps,
) {
  return tool({
    description:
      "Search saved Junior conversation transcripts by keyword within the current context visibility. Live message hits include `event_id` and `message_offset` anchors for transcriptRead. Public Slack channels in the workspace may be visible; private and direct Slack transcripts are limited to the current Slack source or same-workspace destination channel, and local transcripts are limited to the current local source.",
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
          description:
            "Maximum number of matching transcript events to return.",
        }),
      ),
    }),
    execute: async ({ include_links, limit: inputLimit, query }) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        return inputError("Transcript search query is required.");
      }
      const normalizedQuery = trimmedQuery.toLowerCase();
      const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);

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
            if (!textMatches(compaction.summary, normalizedQuery, queryTerms)) {
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
          for (const [offset, message] of state.messages.entries()) {
            if (!textMatches(message.text, normalizedQuery, queryTerms)) {
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
                offset,
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
