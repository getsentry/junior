import { Type } from "@sinclair/typebox";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { tool } from "@/chat/tools/definition";
import type { TranscriptAccess } from "@/chat/tools/transcripts/access";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIMIT,
  includeLinksInput,
  isoTime,
  limit,
  loadTranscriptState,
  projectMessage,
  resolveTranscriptToolDeps,
  resultContent,
  type TranscriptToolDeps,
  type TranscriptToolResolvedDeps,
  visitVisibleTranscripts,
} from "@/chat/tools/transcripts/shared";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function threadTsFromConversationId(
  conversationId: string,
): string | undefined {
  const match = /^slack:[^:]+:(.+)$/.exec(conversationId);
  return match?.[1];
}

async function linkForConversation(args: {
  access: TranscriptAccess;
  deps: TranscriptToolResolvedDeps;
  includeLinks: boolean;
}): Promise<string | undefined> {
  const messageTs = threadTsFromConversationId(
    args.access.conversation.conversationId,
  );
  if (!args.includeLinks || !args.access.slackChannelId || !messageTs) {
    return undefined;
  }
  return await args.deps.getSlackLink({
    channelId: args.access.slackChannelId,
    messageTs,
  });
}

function transcriptSummary(args: {
  access: TranscriptAccess;
  link?: string;
  state: ThreadConversationState;
}) {
  const latestMessage = [...args.state.messages]
    .reverse()
    .find((message) => message.text.trim().length > 0);
  const latest = latestMessage
    ? projectMessage({ message: latestMessage })
    : undefined;
  return {
    conversation_id: args.access.conversation.conversationId,
    destination: args.access.destination,
    display_name: args.access.conversation.channelName,
    title: args.access.conversation.title,
    created_at: isoTime(args.access.conversation.createdAtMs),
    last_activity_at: isoTime(args.access.conversation.lastActivityAtMs),
    message_count: args.state.messages.length,
    compaction_count: args.state.compactions.length,
    ...(args.link ? { link: args.link } : {}),
    ...(latest
      ? {
          latest_message: {
            role: latest.role,
            author: latest.author,
            created_at: latest.created_at,
            excerpt: latest.excerpt,
          },
        }
      : {}),
  };
}

/** Create a tool that lists saved Junior transcripts visible from the current runtime context. */
export function createTranscriptListTool(
  context: ToolRuntimeContext,
  deps?: TranscriptToolDeps,
) {
  return tool({
    description:
      "List saved Junior conversation transcripts visible from the current context. Public Slack channels in the workspace may be visible; private and direct Slack transcripts are limited to the current Slack source or same-workspace destination channel, and local transcripts are limited to the current local source.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({
      include_links: includeLinksInput,
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: "Maximum number of transcripts to return.",
        }),
      ),
    }),
    execute: async ({ include_links, limit: inputLimit }) => {
      const resolvedDeps = resolveTranscriptToolDeps(deps);
      const resultLimit = limit(inputLimit, DEFAULT_LIST_LIMIT);
      const transcripts: Array<Record<string, unknown>> = [];

      await visitVisibleTranscripts({
        context,
        conversationStore: resolvedDeps.conversationStore,
        resultLimit,
        visit: async (access) => {
          const state = await loadTranscriptState(
            resolvedDeps,
            access.conversation.conversationId,
          );
          const link = await linkForConversation({
            access,
            deps: resolvedDeps,
            includeLinks: include_links ?? true,
          });
          transcripts.push(transcriptSummary({ access, link, state }));
          return transcripts.length >= resultLimit;
        },
      });

      return resultContent({
        ok: true,
        count: transcripts.length,
        transcripts,
      });
    },
  });
}
