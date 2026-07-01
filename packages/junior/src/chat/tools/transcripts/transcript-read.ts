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
const EVENT_ID_NOT_FOUND_ERROR =
  "Transcript event_id was not found in retained live messages.";

function messageOffset(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function contextBefore(value: number | undefined, maxBefore: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(maxBefore, Math.floor(value)));
}

function resolveReadOffset(args: {
  contextBefore: number | undefined;
  eventId: string | undefined;
  limit: number;
  offset: number | undefined;
  state: ThreadConversationState;
}):
  | { anchorOffset?: number; ok: true; offset: number }
  | { ok: false; error: string } {
  if (args.eventId && args.offset !== undefined) {
    return {
      ok: false,
      error: "Use either event_id or offset, not both.",
    };
  }
  if (!args.eventId && args.contextBefore !== undefined) {
    return {
      ok: false,
      error: "context_before requires event_id.",
    };
  }
  if (!args.eventId) {
    return { ok: true, offset: messageOffset(args.offset) };
  }

  const anchorOffset = args.state.messages.findIndex(
    (message) => message.id === args.eventId,
  );
  if (anchorOffset < 0) {
    return { ok: false, error: EVENT_ID_NOT_FOUND_ERROR };
  }
  return {
    anchorOffset,
    ok: true,
    offset: Math.max(
      0,
      anchorOffset - contextBefore(args.contextBefore, args.limit - 1),
    ),
  };
}

/** Drop only pre-anchor context when the character cap would hide the anchor. */
function readableStartOffset(args: {
  anchorOffset: number | undefined;
  offset: number;
  state: ThreadConversationState;
}) {
  if (args.anchorOffset === undefined) {
    return args.offset;
  }

  let offset = args.offset;
  let chars = 0;
  for (let index = offset; index <= args.anchorOffset; index += 1) {
    chars += args.state.messages[index]?.text.length ?? 0;
  }
  while (chars > MAX_READ_CHARS && offset < args.anchorOffset) {
    chars -= args.state.messages[offset]?.text.length ?? 0;
    offset += 1;
  }
  return offset;
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
      "Read a bounded message window from one saved Junior conversation transcript by `conversation_id` returned from transcriptList or transcriptSearch. Use `event_id` with optional `context_before` to read from or around a known live message, or use `offset` and `next_offset` to scan retained live messages. Public Slack channels in the workspace may be visible; private and direct Slack transcripts are limited to the current Slack source or same-workspace destination channel, and local transcripts are limited to the current local source.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      conversation_id: Type.String({
        minLength: 1,
        description:
          "Saved Junior conversation id, for example `slack:C123:1700000000.000000` or `local:workspace:run`.",
      }),
      include_links: includeLinksInput,
      event_id: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Stable retained live message event_id returned by transcriptList, transcriptSearch, or transcriptRead. When provided, the read window starts at this message unless context_before shifts it earlier.",
        }),
      ),
      context_before: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_READ_LIMIT,
          description:
            "Number of retained live messages before event_id to include in the returned window.",
        }),
      ),
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
      context_before,
      event_id,
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
      const eventId = event_id?.trim();
      if (event_id !== undefined && !eventId) {
        return inputError("Transcript event_id is required when provided.");
      }
      const resolvedOffset = resolveReadOffset({
        contextBefore: context_before,
        eventId,
        limit: resultLimit,
        offset: inputOffset,
        state,
      });
      if (!resolvedOffset.ok) {
        return inputError(resolvedOffset.error);
      }
      const resultOffset = readableStartOffset({
        anchorOffset: resolvedOffset.anchorOffset,
        offset: resolvedOffset.offset,
        state,
      });
      const selected = state.messages.slice(
        resultOffset,
        resultOffset + resultLimit,
      );
      const messages: Array<Record<string, unknown>> = [];
      let chars = 0;
      for (const [index, message] of selected.entries()) {
        const projected = projectMessage({
          link: await linkForMessage({
            access,
            deps: resolvedDeps,
            includeLinks: include_links ?? true,
            message,
          }),
          message,
          offset: resultOffset + index,
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
        offset: resultOffset,
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
