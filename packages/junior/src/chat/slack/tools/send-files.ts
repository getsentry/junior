import { createHash } from "node:crypto";
import { storeAttachments } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { JuniorSqlDatabase } from "@/db/db";
import { uploadFilesToConversation } from "@/chat/slack/outbound";
import type { SlackToolContext } from "@/chat/slack/tool-support/context";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { createOperationKey } from "@/chat/tools/idempotency";
import {
  sandboxFileReferenceSchema,
  type SandboxFileMaterializationInput,
  type SandboxFileReferenceInput,
  type SandboxFileUpload,
} from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";

/** Convert a model-supplied sandbox file path into bytes safe for Slack upload. */
export type MaterializeFile = (
  input: SandboxFileMaterializationInput,
) => Promise<SandboxFileUpload>;

const sendFilesResultSchema = juniorToolOutputSchema.extend({
  deduplicated: z.boolean().optional(),
  attachment_refs: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});

type SendFilesResult = z.output<typeof sendFilesResultSchema>;

function normalizeFiles(
  files: SandboxFileReferenceInput[],
): SandboxFileMaterializationInput[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.filename ? { filename: file.filename } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
  }));
}

function fileContentDigest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Include file bytes in idempotency so rewritten paths can be sent again. */
function fileOperationInput(files: SandboxFileUpload[]) {
  return files.map((file) => ({
    bytes: file.bytes,
    filename: file.filename,
    mimeType: file.mimeType,
    path: file.path,
    sha256: fileContentDigest(file.data),
  }));
}

/** Create the Slack side-effect tool for active-conversation file messages. */
export function createSendFilesTool(
  context: SlackToolContext,
  state: ToolState,
  materializeFile: MaterializeFile,
  attachments?: {
    conversationId: string;
    db: JuniorSqlDatabase;
    storage: AttachmentStorage;
  },
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Send one or more sandbox files into the active Slack conversation.",
    inputSchema: z.object({
      files: z
        .array(sandboxFileReferenceSchema)
        .min(1)
        .describe(
          "One or more existing sandbox files. Objects returned by imageGenerate or webFetch can be passed unchanged.",
        ),
    }),
    outputSchema: sendFilesResultSchema,
    execute: async ({ files }) => {
      const filesToSend = normalizeFiles(files);
      const activeChannelId = context.sourceChannelId;
      if (!activeChannelId) {
        throw new ToolInputError("No active Slack conversation is available.");
      }
      const threadTs = context.threadTs ?? context.messageTs;
      if (!threadTs) {
        throw new ToolInputError(
          "No active Slack conversation timestamp is available.",
        );
      }
      const materializedFiles = await Promise.all(
        filesToSend.map((file) => materializeFile(file)),
      );
      const operationKey = createOperationKey("sendFiles", {
        channel_id: activeChannelId,
        thread_ts: threadTs,
        files: fileOperationInput(materializedFiles),
      });
      const cached = state.getOperationResult<SendFilesResult>(operationKey);
      if (cached) {
        return sendFilesResultSchema.parse({
          ...cached,
          deduplicated: true,
        });
      }

      const stored = attachments
        ? await storeAttachments({
            conversationId: attachments.conversationId,
            db: attachments.db,
            files: materializedFiles,
            storage: attachments.storage,
          })
        : [];
      const uploads = materializedFiles.map((file) => ({
        data: file.data,
        filename: file.filename,
      }));
      await uploadFilesToConversation({
        channelId: activeChannelId,
        files: uploads,
        threadTs,
      });
      const response: SendFilesResult = {
        attachment_refs: stored.map((attachment, index) => ({
          id: attachment.id,
          name: materializedFiles[index]!.filename,
        })),
      };
      state.setOperationResult(operationKey, response);
      return response;
    },
  });
}
