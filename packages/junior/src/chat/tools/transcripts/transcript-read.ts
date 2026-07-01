import { Type } from "@sinclair/typebox";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { tool } from "@/chat/tools/definition";
import { transcriptAccess } from "@/chat/tools/transcripts/access";
import {
  DEFAULT_READ_LIMIT,
  MAX_READ_LIMIT,
  TRANSCRIPT_UNAVAILABLE_ERROR,
  includeLinksInput,
  inputError,
  isoTime,
  limit,
  linkForMessage,
  loadTranscriptState,
  projectCompaction,
  projectMessage,
  resolveTranscriptToolDeps,
  resultContent,
  type TranscriptToolDeps,
} from "@/chat/tools/transcripts/shared";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const MAX_READ_CHARS = 40_000;

function messageOffset(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function retainedMessageCount(state: ThreadConversationState): number {
  return (
    state.messages.length +
    state.compactions.reduce(
      (total, compaction) => total + compaction.coveredMessageIds.length,
      0,
    )
  );
}

/** Create a tool that reads a bounded window from one saved Junior transcript. */
export function createTranscriptReadTool(
  context: ToolRuntimeContext,
  deps?: TranscriptToolDeps,
) {
  return tool({
    description:
      "Read a bounded message window from one saved Junior conversation transcript by `conversation_id` returned from transcriptList or transcriptSearch. Use `offset` and `next_offset` to scan through retained live messages. Public Slack channels in the workspace may be visible; private and direct Slack transcripts are limited to the current Slack source or same-workspace destination channel, and local transcripts are limited to the current local source.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      conversation_id: Type.String({
        minLength: 1,
        description:
          "Saved Junior conversation id, for example `slack:C123:1700000000.000000` or `local:workspace:run`.",
      }),
      include_links: includeLinksInput,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_READ_LIMIT,
          description:
            "Maximum number of retained live transcript messages to return in this window.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Message offset for scanning through retained live transcript messages.",
        }),
      ),
    }),
    execute: async ({
      conversation_id,
      include_links,
      limit: inputLimit,
      offset: inputOffset,
    }) => {
      const resolvedDeps = resolveTranscriptToolDeps(deps);
      const conversation = await resolvedDeps.conversationStore.get({
        conversationId: conversation_id,
      });
      if (!conversation) {
        return inputError(TRANSCRIPT_UNAVAILABLE_ERROR);
      }
      const access = transcriptAccess(conversation, context);
      if (!access) {
        return inputError(TRANSCRIPT_UNAVAILABLE_ERROR);
      }

      const state = await loadTranscriptState(resolvedDeps, conversation_id);
      const resultLimit = limit(inputLimit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
      const resultOffset = messageOffset(inputOffset);
      const selected = state.messages.slice(
        resultOffset,
        resultOffset + resultLimit,
      );
      const messages: Array<Record<string, unknown>> = [];
      let chars = 0;
      for (const message of selected) {
        const projected = projectMessage({
          link: await linkForMessage({
            access,
            deps: resolvedDeps,
            includeLinks: include_links ?? true,
            message,
          }),
          message,
        });
        const textLength = message.text.length;
        if (messages.length > 0 && chars + textLength > MAX_READ_CHARS) {
          break;
        }
        chars += textLength;
        messages.push(projected);
      }

      return resultContent({
        ok: true,
        conversation_id,
        destination: access.destination,
        display_name: conversation.channelName,
        title: conversation.title,
        created_at: isoTime(conversation.createdAtMs),
        last_activity_at: isoTime(conversation.lastActivityAtMs),
        count: messages.length,
        total_message_count: retainedMessageCount(state),
        live_message_count: state.messages.length,
        compaction_count: state.compactions.length,
        compactions: state.compactions.map((compaction) =>
          projectCompaction({ compaction }),
        ),
        truncated:
          resultOffset + messages.length < state.messages.length ||
          messages.length < selected.length,
        ...(resultOffset + messages.length < state.messages.length
          ? { next_offset: resultOffset + messages.length }
          : {}),
        messages,
      });
    },
  });
}
