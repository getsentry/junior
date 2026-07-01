import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIMIT,
  includeLinksInput,
} from "@/chat/tools/transcripts/constants";
import {
  loadTranscriptState,
  resolveTranscriptToolDeps,
  type TranscriptToolDeps,
} from "@/chat/tools/transcripts/deps";
import { limit } from "@/chat/tools/transcripts/limits";
import { linkForConversation } from "@/chat/tools/transcripts/links";
import {
  resultContent,
  transcriptSummary,
} from "@/chat/tools/transcripts/projection";
import { visitVisibleTranscripts } from "@/chat/tools/transcripts/scan";
import type { ToolRuntimeContext } from "@/chat/tools/types";

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
