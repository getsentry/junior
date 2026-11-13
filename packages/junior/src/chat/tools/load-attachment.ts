import path from "node:path";
import * as z from "zod";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  readLiveAttachment,
  type StoredAttachment,
} from "@/chat/attachments/store";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import { recordAttachmentsDelivered } from "@/chat/conversations/projection";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const ATTACHMENT_DIR = ".junior/attachments";

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Create a tool that restores one conversation attachment to the sandbox. */
export function createLoadAttachmentTool(args: {
  conversationId: string;
  db: JuniorSqlDatabase;
  storage: AttachmentStorage;
  /**
   * Store a file of the Conversation's provider thread by its provider file
   * id. Returns `undefined` when the id is not a provider file id.
   */
  storeProviderFile?: (fileId: string) => Promise<StoredAttachment | undefined>;
  workspace: SandboxWorkspace;
}) {
  const readAttachment = async (attachmentId: string) =>
    await readLiveAttachment({
      attachmentId,
      conversationId: args.conversationId,
      db: args.db,
    });
  return zodTool({
    description: "Load a file of this conversation into the sandbox.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z.object({
      attachment_id: z
        .string()
        .min(1)
        .describe(
          "Attachment id from attachment context, or the Slack file id (`F…`) of a file in the current thread.",
        ),
    }),
    outputSchema: juniorToolOutputSchema,
    execute: async ({ attachment_id }, options) => {
      let attachment = await readAttachment(attachment_id);
      if (!attachment && args.storeProviderFile) {
        const stored = await args.storeProviderFile(attachment_id);
        if (stored) attachment = await readAttachment(stored.id);
      }
      if (!attachment || attachment.storageProvider !== args.storage.provider) {
        throw new ToolInputError("Attachment not found in this conversation.");
      }
      const body = await args.storage.get(attachment.storageKey);
      if (!body) {
        throw new ToolInputError("Stored attachment contents are unavailable.");
      }
      const data = await readStream(body);
      if (data.byteLength !== attachment.bytes) {
        // A storage read that returns fewer (or more) bytes than the durable
        // row expects is corrupt, not a valid empty/short file. Fail loudly
        // instead of silently writing truncated content to the sandbox.
        throw new Error(
          `Attachment ${attachment.id} read ${data.byteLength} bytes, expected ${attachment.bytes}.`,
        );
      }
      const attachmentDir = path.posix.join(ATTACHMENT_DIR, attachment.id);
      const sandboxPath = path.posix.join(
        attachmentDir,
        path.posix.basename(attachment.filename),
      );
      const mkdir = await args.workspace.runCommand({
        cmd: "mkdir",
        args: ["-p", attachmentDir],
      });
      if (mkdir.exitCode !== 0) {
        throw new Error(
          `Failed to create attachment directory: ${mkdir.stderr}`,
        );
      }
      await args.workspace.writeFiles([{ content: data, path: sandboxPath }]);
      // The transcript shows the file at the tool call that read it.
      if (options?.toolCallId) {
        await recordAttachmentsDelivered({
          attachments: [attachment],
          conversationId: args.conversationId,
          toolCallId: options.toolCallId,
        });
      }
      return {
        path: sandboxPath,
        filename: attachment.filename,
        mime_type: attachment.contentType,
        bytes: attachment.bytes,
      };
    },
  });
}
