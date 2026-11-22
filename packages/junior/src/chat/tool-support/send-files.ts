import { mapBounded } from "@/chat/fan-out";
import { createHash } from "node:crypto";
import { storeAttachments } from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { recordAttachmentsDelivered } from "@/chat/conversations/projection";
import type { JuniorSqlDatabase } from "@/db/db";
import * as z from "zod";
import { createOperationKey } from "@/chat/tool-support/idempotency";
import {
  sandboxFileReferenceSchema,
  type SandboxFileMaterializationInput,
  type SandboxFileReferenceInput,
  type SandboxFileUpload,
} from "@/chat/sandbox/file-uploads";
import type { ToolState } from "@/chat/tool-support/types";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";

/** Read and validate a sandbox file before storage or delivery. */
export type MaterializeFile = (
  input: SandboxFileMaterializationInput,
) => Promise<SandboxFileUpload>;

/** Result of `sendFiles`: the stored attachments. */
export const sendFilesResultSchema = juniorToolOutputSchema.extend({
  deduplicated: z.boolean().optional(),
  attachment_refs: z.array(
    z.object({
      id: z.string().min(1),
      filename: z.string().min(1),
    }),
  ),
});

type DeliveredAttachment = {
  bytes: number;
  contentType: string;
  filename: string;
  id: string;
};

/** Keep the first delivery identity when a tool call is retried. */
type CachedSendFiles = {
  delivered: DeliveredAttachment[];
  toolCallId?: string;
};

function normalizeFiles(
  files: SandboxFileReferenceInput[],
): SandboxFileMaterializationInput[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.filename ? { filename: file.filename } : undefined),
    ...(file.mime_type ? { mime_type: file.mime_type } : undefined),
  }));
}

/** Include file bytes in idempotency so rewritten paths can be sent again. */
function fileOperationInput(files: SandboxFileUpload[]) {
  return files.map((file) => ({
    bytes: file.bytes,
    filename: file.filename,
    mimeType: file.mimeType,
    path: file.path,
    sha256: createHash("sha256").update(file.data).digest("hex"),
  }));
}

/** Conversation storage for sent files. */
export type FileAttachments = {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: AttachmentStorage;
};

/** Delivery of sent files to the Location of the Conversation. */
export type FileDelivery = {
  key: string;
  send: (files: SandboxFileUpload[]) => Promise<void>;
};

/** Input of `sendFiles`: sandbox files to send. */
export const sendFilesInputSchema = z.object({
  files: z
    .array(sandboxFileReferenceSchema)
    .min(1)
    .describe(
      "One or more existing sandbox files. Objects returned by imageGenerate or webFetch can be passed unchanged.",
    ),
});

/**
 * Store files in the active Conversation and optionally deliver them to its
 * Location. A retried tool call does not store or deliver the files again.
 */
export async function sendFiles(
  { files }: z.output<typeof sendFilesInputSchema>,
  options: { toolCallId?: string | undefined },
  state: ToolState,
  materializeFile: MaterializeFile,
  output: {
    attachments?: FileAttachments | undefined;
    delivery?: FileDelivery;
  },
): Promise<z.output<typeof sendFilesResultSchema>> {
  const { attachments, delivery } = output;
  const filesToSend = normalizeFiles(files);
  const materializedFiles = await mapBounded(filesToSend, (file) =>
    materializeFile(file),
  );
  const operationKey = createOperationKey("sendFiles", {
    conversation_id: attachments?.conversationId,
    delivery: delivery?.key,
    files: fileOperationInput(materializedFiles),
  });
  let cached = state.getOperationResult<CachedSendFiles>(operationKey);
  const deduplicated = Boolean(cached);
  if (!cached) {
    const stored = attachments
      ? await storeAttachments({
          conversationId: attachments.conversationId,
          db: attachments.db,
          files: materializedFiles,
          storage: attachments.storage,
        })
      : [];
    await delivery?.send(materializedFiles);
    const delivered: DeliveredAttachment[] = stored.map((attachment, index) => {
      const file = materializedFiles[index]!;
      return {
        id: attachment.id,
        filename: file.filename,
        contentType: file.mimeType,
        bytes: file.bytes,
      };
    });
    // Cache before recording the event so a retry cannot send files twice.
    cached = {
      delivered,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : undefined),
    };
    state.setOperationResult(operationKey, cached);
  }
  if (attachments && cached.delivered.length > 0) {
    await recordAttachmentsDelivered({
      attachments: cached.delivered,
      conversationId: attachments.conversationId,
      ...(cached.toolCallId ? { toolCallId: cached.toolCallId } : undefined),
    });
  }
  const result: z.output<typeof sendFilesResultSchema> = {
    attachment_refs: cached.delivered.map(({ id, filename }) => ({
      id,
      filename,
    })),
  };
  if (deduplicated) result.deduplicated = true;
  return result;
}
