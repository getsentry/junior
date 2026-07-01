import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";
import { transcriptAccess } from "@/chat/tools/transcripts/access";
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
import { limit, scanLimit } from "@/chat/tools/transcripts/limits";
import { linkForConversation } from "@/chat/tools/transcripts/links";
import {
  resultContent,
  transcriptSummary,
} from "@/chat/tools/transcripts/projection";
import type { ToolRuntimeContext } from "@/chat/tools/types";

/** Create a tool that lists saved Junior transcripts visible from the current source. */
export function createTranscriptListTool(
  context: ToolRuntimeContext,
  deps?: TranscriptToolDeps,
) {
  return tool({
    description:
      "List saved Junior conversation transcripts visible from the current source. Public workspace channels may be visible; private, direct, and local transcripts are limited to the current source.",
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
      const scan = scanLimit(resultLimit);
      const rows = await resolvedDeps.conversationStore.listByActivity({
        limit: scan,
      });
      const transcripts: Array<Record<string, unknown>> = [];

      for (const conversation of rows) {
        const access = transcriptAccess(conversation, context);
        if (!access) {
          continue;
        }
        const state = await loadTranscriptState(
          resolvedDeps,
          conversation.conversationId,
        );
        const link = await linkForConversation({
          access,
          deps: resolvedDeps,
          includeLinks: include_links ?? true,
        });
        transcripts.push(transcriptSummary({ access, link, state }));
        if (transcripts.length >= resultLimit) {
          break;
        }
      }

      return resultContent({
        ok: true,
        count: transcripts.length,
        transcripts,
      });
    },
  });
}
