/**
 * The tool that reads the Walkthrough a question Turn answers about. The
 * Turn worker binds the version, so the model names no version.
 */
import * as z from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { WalkthroughQuestions } from "./questions";
import { walkthroughOutputSchema } from "./schema";
import { readWalkthroughDocument } from "./store";

export const READ_WALKTHROUGH_TOOL_NAME = "readWalkthrough";

/** Create `readWalkthrough` for one question Turn. */
export function createReadWalkthroughTool(
  context: ToolRuntimeContext,
  questions: WalkthroughQuestions,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "Read the Walkthrough that this Conversation is about: its code changes, story, chapters, decisions, and citations.",
    inputSchema: z.object({}).strict(),
    outputSchema: juniorToolOutputSchema.extend({
      repository: z.string(),
      code_changes: z.array(
        z.object({
          pr: z.number().int(),
          title: z.string(),
          url: z.string(),
          base_sha: z.string(),
          head_sha: z.string(),
        }),
      ),
      source_conversation_id: z.string().optional(),
      walkthrough: walkthroughOutputSchema,
    }),
    execute: async () => {
      if (!context.attachmentStorage) {
        throw new Error("Attachment storage is unavailable.");
      }
      const document = await readWalkthroughDocument(
        context.attachmentStorage,
        questions,
      );
      if (!document) {
        throw new Error(
          `Walkthrough version ${questions.versionId} has no stored document`,
        );
      }
      return {
        repository: document.repository,
        code_changes: document.layers.map((layer) => ({
          pr: layer.pr,
          title: layer.title,
          url: layer.url,
          base_sha: layer.baseSha,
          head_sha: layer.headSha,
        })),
        ...(document.sourceConversationId
          ? { source_conversation_id: document.sourceConversationId }
          : undefined),
        walkthrough: document.content,
      };
    },
  });
}
