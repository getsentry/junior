import { createHash } from "node:crypto";
import { storeAttachments } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { recordAttachmentsDelivered } from "@/chat/conversations/projection";
import type { JuniorSqlDatabase } from "@/db/db";
import { z } from "zod";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { createOperationKey } from "@/chat/tools/idempotency";
import {
  sandboxFileReferenceSchema,
  type SandboxFileMaterializationInput,
  type SandboxFileReferenceInput,
  type SandboxFileUpload,
} from "@/chat/tools/sandbox/file-uploads";
import type { ToolState } from "@/chat/tools/types";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";

/** Read and validate a sandbox file before storage or delivery. */
export type MaterializeFile = (
  input: SandboxFileMaterializationInput,
) => Promise<SandboxFileUpload>;

const sendFilesResultSchema = juniorToolOutputSchema.extend({
  deduplicated: z.boolean().optional(),
  attachment_refs: z.array(
    z.object({
      id: z.string().min(1),
      // Same noun as storage, delivery events, and the report API.
      filename: z.string().min(1),
    }),
  ),
});

type SendFilesResult = z.output<typeof sendFilesResultSchema>;

type DeliveredAttachment = {
  bytes: number;
  contentType: string;
  filename: string;
  id: string;
};

/** Operation cache keeps delivery metadata so retries can re-record safely. */
type CachedSendFiles = {
  delivered: DeliveredAttachment[];
  result: SendFilesResult;
  /** Identity used for the first delivery event; retries must reuse it. */
  toolCallId?: string;
};

function normalizeFiles(
  files: SandboxFileReferenceInput[],
): SandboxFileMaterializationInput[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.filename ? { filename: file.filename } : undefined),
    ...(file.mimeType ? { mimeType: file.mimeType } : undefined),
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

type FileAttachments = {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: AttachmentStorage;
};

type FileDelivery = {
  key: string;
  description: string;
  send: (files: SandboxFileUpload[]) => Promise<void>;
};

/** Store files in the active Conversation and optionally deliver them to its Location. */
export function createSendFilesTool(
  state: ToolState,
  materializeFile: MaterializeFile,
  ...[attachments, delivery]:
    | [attachments: FileAttachments, delivery?: FileDelivery]
    | [attachments: FileAttachments | undefined, delivery: FileDelivery]
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      delivery?.description ??
      "Attach one or more sandbox files to the active conversation. Files use the conversation's access rules; this does not publish public URLs.",
    inputSchema: z.object({
      files: z
        .array(sandboxFileReferenceSchema)
        .min(1)
        .describe(
          "One or more existing sandbox files. Objects returned by imageGenerate or webFetch can be passed unchanged.",
        ),
    }),
    outputSchema: sendFilesResultSchema,
    execute: async ({ files }, options) => {
      const filesToSend = normalizeFiles(files);
      const materializedFiles = await Promise.all(
        filesToSend.map((file) => materializeFile(file)),
      );
      const operationKey = createOperationKey("sendFiles", {
        conversation_id: attachments?.conversationId,
        delivery: delivery?.key,
        files: fileOperationInput(materializedFiles),
      });
      const cached = state.getOperationResult<CachedSendFiles>(operationKey);
      if (cached) {
        // A prior attempt may have delivered files and cached before the
        // transcript event landed. Re-record with the original delivery identity
        // so a later toolCallId cannot mint a second transcript row.
        if (attachments && cached.delivered.length > 0) {
          await recordAttachmentsDelivered({
            attachments: cached.delivered,
            conversationId: attachments.conversationId,
            ...(cached.toolCallId
              ? { toolCallId: cached.toolCallId }
              : undefined),
          });
        }
        return sendFilesResultSchema.parse({
          ...cached.result,
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
      await delivery?.send(materializedFiles);
      const delivered: DeliveredAttachment[] = stored.map(
        (attachment, index) => {
          const file = materializedFiles[index]!;
          return {
            id: attachment.id,
            filename: file.filename,
            contentType: file.mimeType,
            bytes: file.bytes,
          };
        },
      );
      const response: SendFilesResult = {
        // Tool result stays minimal; transcript/report carries full metadata.
        attachment_refs: delivered.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
        })),
      };
      // Cache before host bookkeeping so a later event-write failure cannot
      // cause another delivery on retry.
      state.setOperationResult(operationKey, {
        delivered,
        result: response,
        ...(options.toolCallId
          ? { toolCallId: options.toolCallId }
          : undefined),
      } satisfies CachedSendFiles);
      if (attachments && delivered.length > 0) {
        await recordAttachmentsDelivered({
          attachments: delivered,
          conversationId: attachments.conversationId,
          ...(options.toolCallId
            ? { toolCallId: options.toolCallId }
            : undefined),
        });
      }
      return response;
    },
  });
}
